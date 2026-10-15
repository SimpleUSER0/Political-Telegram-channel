import asyncio
import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .models import now

logger = logging.getLogger(__name__)


class Worker:
    def __init__(self, settings, store, newsroom, approval):
        self.settings, self.store, self.newsroom, self.approval = (
            settings,
            store,
            newsroom,
            approval,
        )

    async def schedule(self):
        if not self.settings.scheduler_enabled:
            return
        local = now().astimezone(ZoneInfo(self.settings.timezone))
        for slot in self.settings.slots:
            scheduled = datetime.combine(
                local.date(), datetime.strptime(slot, "%H:%M").time(), local.tzinfo
            )
            if not timedelta(0) <= local - scheduled <= timedelta(minutes=15):
                continue
            await self.store.enqueue(
                "generate",
                {
                    "query": "მნიშვნელოვანი ახალი პოლიტიკური მოვლენები",
                    "post_format": self.settings.default_format,
                },
                key=f"schedule:{local.date()}:{slot}",
            )

    async def step(self, kinds=None):
        await self.store.heartbeat()
        await self.store.recover()
        await self.schedule()
        job = await self.store.take_job(kinds)
        if job is None:
            return False
        try:
            async with asyncio.timeout(self.settings.job_timeout_seconds):
                if job.kind == "generate":
                    draft = await self.newsroom.generate(**job.payload)
                    await self.approval.notify(draft)
                    result = {"draft_id": draft.id}
                elif job.kind == "telegram":
                    await self.approval.process_update(job.payload)
                    result = {"handled": True}
                elif job.kind == "notify":
                    draft = await self.store.get_draft(job.payload["draft_id"])
                    if not draft:
                        raise ValueError("Unknown draft")
                    result = {"message_id": await self.approval.notify(draft)}
                elif job.kind == "edit":
                    draft = await self.store.get_draft(job.payload["draft_id"])
                    if not draft:
                        raise ValueError("Unknown draft")
                    revised = await self.newsroom.edit(
                        draft, job.payload["title"], job.payload["body"], job.payload["version"]
                    )
                    await self.approval.telegram.remove_keyboard(draft.owner_message_id)
                    await self.approval.notify(revised)
                    result = {"draft_id": revised.id, "version": revised.version}
                else:
                    raise ValueError("Unknown job kind")
            await self.store.finish_job(job.id, result)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Exception messages/HTTP request URLs can contain credentials or source content.
            code = type(error).__name__
            logger.warning("job_failed", extra={"job_id": job.id, "error_type": code})
            await self.store.finish_job(job.id, error=code)
            try:
                await self.approval.telegram.message(
                    f"დავალება ვერ დასრულდა: {job.id}\nტიპი: {code}\n"
                    "გამოქვეყნების გაურკვეველი შედეგისას არხი შეამოწმე; ხელახლა ავტომატურად არ გაიგზავნება."
                )
            except Exception:
                logger.warning("owner_notification_failed", extra={"job_id": job.id})
        return True

    async def consume(self, kinds):
        while True:
            try:
                did_work = await self.step(kinds)
                if not did_work:
                    await asyncio.sleep(2)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.error("worker_iteration_failed", extra={"error_type": type(error).__name__})
                await asyncio.sleep(5)

    async def maintain(self):
        while True:
            try:
                await self.store.heartbeat()
                await self.store.recover()
                await self.schedule()
            except Exception as error:
                logger.error(
                    "worker_maintenance_failed", extra={"error_type": type(error).__name__}
                )
            await asyncio.sleep(10)

    async def run(self):
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(self.maintain())
            tasks.create_task(self.consume(["generate"]))
            tasks.create_task(self.consume(["telegram", "edit", "notify"]))
