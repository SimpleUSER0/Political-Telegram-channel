import asyncio
import hmac
import json
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from .config import Settings
from .db import Store
from .logging_config import configure_logging
from .media import CommonsMedia
from .models import Draft, Job
from .newsroom import LLM, Newsroom
from .schemas import EditRequest, GenerateRequest
from .telegram import ApprovalService, Telegram
from .worker import Worker


def create_app(settings=None, store=None, telegram=None, llm=None):
    settings = settings or Settings()
    store = store or Store(settings)
    llm = llm or LLM(settings, store)
    telegram = telegram or Telegram(settings)
    media = CommonsMedia()
    newsroom = Newsroom(settings, store, llm, media)
    approval = ApprovalService(settings, store, telegram, newsroom, media)
    worker = Worker(settings, store, newsroom, approval)

    @asynccontextmanager
    async def lifespan(app):
        configure_logging()
        if settings.app_env != "production":
            await store.create_schema()
        await store.stats()  # Missing migrations fail startup rather than lose state.
        if settings.app_env == "production" and settings.telegram_bot_token.get_secret_value():
            await telegram.verify_identity(check_channel=settings.publishing_enabled)
        task = asyncio.create_task(worker.run()) if settings.worker_enabled else None
        try:
            yield
        finally:
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
            await telegram.close()
            await llm.close()
            await store.engine.dispose()

    app = FastAPI(
        title="Political Newsroom",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.store, app.state.worker = store, worker
    app.state.approval, app.state.newsroom = approval, newsroom

    async def admin(authorization: str = Header(default="")):
        expected = settings.admin_api_token.get_secret_value()
        supplied = (
            authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
        )
        if len(expected) < 32 or not hmac.compare_digest(expected, supplied):
            raise HTTPException(401, "Unauthorized")

    @app.get("/health")
    async def health():
        try:
            async with store.session() as session:
                await session.execute(select(1))
            return {"status": "ok"}
        except Exception:
            return JSONResponse({"status": "database_unavailable"}, status_code=503)

    @app.get("/ready")
    async def ready():
        try:
            stats = await store.stats()
            beat = stats["worker_heartbeat"]
            stamp = datetime.fromisoformat(beat) if beat else None
            if stamp and stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=UTC)
            worker_ready = bool(
                settings.worker_enabled
                and stamp
                and (datetime.now(UTC) - stamp).total_seconds() < settings.job_timeout_seconds + 60
            )
            configured = not settings.research_missing() and bool(
                settings.telegram_bot_token.get_secret_value()
            )
            ok = worker_ready and configured
            return JSONResponse(
                {"ready": ok, "publishing_enabled": settings.publishing_enabled},
                status_code=200 if ok else 503,
            )
        except Exception:
            return JSONResponse({"ready": False}, status_code=503)

    @app.post("/telegram/webhook")
    async def webhook(request: Request):
        expected = settings.telegram_webhook_secret.get_secret_value()
        supplied = request.headers.get("x-telegram-bot-api-secret-token", "")
        if len(expected) < 32 or not hmac.compare_digest(expected, supplied):
            raise HTTPException(401, "Unauthorized")
        if not settings.worker_enabled:
            raise HTTPException(503, "Worker disabled")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > settings.max_webhook_bytes:
                raise HTTPException(413, "Update too large")
        try:
            data = json.loads(body)
        except (ValueError, UnicodeError):
            raise HTTPException(400, "Invalid JSON") from None
        if (
            not isinstance(data, dict)
            or type(data.get("update_id")) is not int
            or data["update_id"] < 0
        ):
            raise HTTPException(400, "Invalid update")
        event = data.get("callback_query") or data.get("message")
        if not isinstance(event, dict):
            return {"ok": True}
        message = event.get("message", {}) if "callback_query" in data else event
        if not isinstance(message, dict) or not isinstance(event.get("from"), dict):
            return {"ok": True}
        chat = message.get("chat")
        if (
            event["from"].get("id") != settings.owner_chat_id
            or not isinstance(chat, dict)
            or chat.get("id") != settings.owner_chat_id
            or chat.get("type") != "private"
        ):
            return {"ok": True}  # Do not enqueue untrusted user commands.
        job_id = await store.enqueue("telegram", data, update_id=data["update_id"])
        return {"ok": True, "job_id": job_id}

    @app.get("/admin/status", dependencies=[Depends(admin)])
    async def status():
        return {
            **await store.stats(),
            "missing_research_config": settings.research_missing(),
            "publishing_enabled": settings.publishing_enabled,
            "worker_enabled": settings.worker_enabled,
            "scheduler_enabled": settings.scheduler_enabled,
            "schedule": settings.slots,
        }

    @app.post("/admin/generate", dependencies=[Depends(admin)], status_code=202)
    async def generate(body: GenerateRequest):
        if settings.research_missing():
            raise HTTPException(503, "Research is not configured")
        if not settings.worker_enabled:
            raise HTTPException(503, "Worker disabled")
        return {"job_id": await store.enqueue("generate", body.model_dump())}

    @app.get("/admin/jobs/{job_id}", dependencies=[Depends(admin)])
    async def job(job_id: str):
        async with store.session() as session:
            row = await session.get(Job, job_id)
            if not row:
                raise HTTPException(404, "Job not found")
            return {
                "id": row.id,
                "status": row.status,
                "kind": row.kind,
                "attempts": row.attempts,
                "result": row.result,
                "error": row.error,
                "created_at": row.created_at,
                "finished_at": row.finished_at,
            }

    @app.get("/admin/drafts", dependencies=[Depends(admin)])
    async def drafts():
        async with store.session() as session:
            rows = (
                await session.scalars(select(Draft).order_by(Draft.created_at.desc()).limit(100))
            ).all()
            return [
                {
                    "id": d.id,
                    "version": d.version,
                    "topic": d.topic,
                    "status": d.status,
                    "expires_at": d.expires_at,
                }
                for d in rows
            ]

    @app.get("/admin/drafts/{draft_id}", dependencies=[Depends(admin)])
    async def draft(draft_id: str):
        row = await store.get_draft(draft_id)
        if not row:
            raise HTTPException(404, "Draft not found")
        return {
            "id": row.id,
            "version": row.version,
            "status": row.status,
            "payload": row.payload,
            "message_id": row.message_id,
            "expires_at": row.expires_at,
        }

    @app.post("/admin/drafts/{draft_id}/edit", dependencies=[Depends(admin)], status_code=202)
    async def edit(draft_id: str, body: EditRequest):
        if not settings.worker_enabled or settings.research_missing():
            raise HTTPException(503, "Worker or research is not configured")
        if not await store.get_draft(draft_id):
            raise HTTPException(404, "Draft not found")
        return {"job_id": await store.enqueue("edit", {"draft_id": draft_id, **body.model_dump()})}

    @app.post("/admin/drafts/{draft_id}/notify", dependencies=[Depends(admin)], status_code=202)
    async def notify(draft_id: str):
        row = await store.get_draft(draft_id)
        if not row or row.status != "pending":
            raise HTTPException(409, "Pending draft required")
        if not settings.worker_enabled:
            raise HTTPException(503, "Worker disabled")
        return {"job_id": await store.enqueue("notify", {"draft_id": draft_id})}

    class Reconciliation(BaseModel):
        message_id: int = Field(gt=0)

    @app.post("/admin/drafts/{draft_id}/reconcile", dependencies=[Depends(admin)])
    async def reconcile(draft_id: str, body: Reconciliation):
        from .db import Conflict

        try:
            await store.reconcile(draft_id, body.message_id, "owner-admin")
        except Conflict as error:
            raise HTTPException(409, str(error)) from None
        return {"status": "published", "message_id": body.message_id}

    return app
