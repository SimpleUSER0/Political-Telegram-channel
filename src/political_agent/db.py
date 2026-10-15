from datetime import timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from .models import Audit, Base, Draft, Heartbeat, Job, Revision, UpdateReceipt, Usage, now, uid


class Conflict(ValueError):
    """The requested state transition is no longer valid."""


class BudgetExceeded(ValueError):
    pass


class Store:
    def __init__(self, settings):
        self.settings = settings
        self.engine = create_async_engine(settings.async_database_url, pool_pre_ping=True)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)

    async def create_schema(self):
        """Tests/dev only. Production uses Alembic before starting the service."""
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    def insert(self, model):
        return (
            pg_insert(model) if self.engine.dialect.name == "postgresql" else sqlite_insert(model)
        )

    async def reserve(self, field):
        if field not in {"runs", "calls"}:
            raise ValueError("Unknown budget")
        day = now().astimezone(ZoneInfo(self.settings.timezone)).date().isoformat()
        limit = (
            self.settings.max_daily_runs if field == "runs" else self.settings.max_daily_api_calls
        )
        column = getattr(Usage, field)
        async with self.session.begin() as session:
            await session.execute(self.insert(Usage).values(day=day).on_conflict_do_nothing())
            result = await session.execute(
                update(Usage).where(Usage.day == day, column < limit).values({field: column + 1})
            )
            if not result.rowcount:
                raise BudgetExceeded(f"Daily {field} limit reached")
        return day

    async def record_usage(self, day, usage, search_calls):
        async with self.session.begin() as session:
            await session.execute(
                update(Usage)
                .where(Usage.day == day)
                .values(
                    input_tokens=Usage.input_tokens + int(getattr(usage, "input_tokens", 0)),
                    output_tokens=Usage.output_tokens + int(getattr(usage, "output_tokens", 0)),
                    search_calls=Usage.search_calls + search_calls,
                )
            )

    async def enqueue(self, kind, payload, key=None, update_id=None):
        job_id = uid()
        try:
            async with self.session.begin() as session:
                session.add(Job(id=job_id, kind=kind, payload=payload, dedupe_key=key))
                if update_id is not None:
                    session.add(UpdateReceipt(update_id=update_id, job_id=job_id))
            return job_id
        except IntegrityError:
            async with self.session() as session:
                if update_id is not None:
                    receipt = await session.get(UpdateReceipt, update_id)
                    if receipt:
                        return receipt.job_id
                if key:
                    return await session.scalar(select(Job.id).where(Job.dedupe_key == key))
            raise

    async def take_job(self, kinds=None):
        async with self.session.begin() as session:
            statement = select(Job.id).where(Job.status == "queued")
            if kinds:
                statement = statement.where(Job.kind.in_(kinds))
            job_id = await session.scalar(statement.order_by(Job.created_at).limit(1))
            if not job_id:
                return None
            result = await session.execute(
                update(Job)
                .where(Job.id == job_id, Job.status == "queued")
                .values(status="running", started_at=now(), attempts=Job.attempts + 1)
            )
            if not result.rowcount:
                return None
            return await session.get(Job, job_id)

    async def finish_job(self, job_id, result=None, error=None):
        async with self.session.begin() as session:
            await session.execute(
                update(Job)
                .where(Job.id == job_id, Job.status == "running")
                .values(
                    status="failed" if error else "done",
                    result=result or {},
                    error=error,
                    finished_at=now(),
                )
            )

    async def recover(self):
        """Never replay an interrupted external send or a paid generation automatically."""
        cutoff = now() - timedelta(seconds=self.settings.job_timeout_seconds + 60)
        async with self.session.begin() as session:
            await session.execute(
                update(Job)
                .where(Job.status == "running", Job.started_at < cutoff)
                .values(
                    status="failed", error="Interrupted; inspect before retry", finished_at=now()
                )
            )
            # Publishing is intentionally not reset to pending, even after a restart.
            await session.execute(
                update(Draft)
                .where(Draft.status == "publishing", Draft.approved_at < cutoff)
                .values(status="unknown")
            )

    async def heartbeat(self):
        async with self.session.begin() as session:
            statement = self.insert(Heartbeat).values(name="worker", updated_at=now())
            await session.execute(
                statement.on_conflict_do_update(
                    index_elements=[Heartbeat.name], set_={"updated_at": now()}
                )
            )

    async def history(self):
        cutoff = now() - timedelta(days=self.settings.history_days)
        async with self.session() as session:
            return list(
                (
                    await session.scalars(
                        select(Draft).where(
                            Draft.created_at >= cutoff,
                            Draft.status.in_(
                                ["pending", "editing", "publishing", "published", "unknown"]
                            ),
                        )
                    )
                ).all()
            )

    async def create_draft(self, candidate, payload):
        from .safety import normalize

        draft = Draft(
            event_key=normalize(candidate.event_key),
            topic=candidate.topic,
            category=candidate.category,
            post_format=payload["post_format"],
            payload=payload,
            expires_at=now() + timedelta(minutes=self.settings.draft_ttl_minutes),
        )
        async with self.session.begin() as session:
            session.add(draft)
            await session.flush()
            session.add(Revision(draft_id=draft.id, version=1, payload=payload))
            session.add(Audit(draft_id=draft.id, action="created", actor="pipeline"))
        return draft

    async def get_draft(self, draft_id):
        async with self.session() as session:
            return await session.get(Draft, draft_id)

    async def transition(self, draft_id, version, action, actor):
        target = {"publish": "publishing", "cancel": "cancelled", "edit": "editing"}[action]
        async with self.session.begin() as session:
            conditions = [Draft.id == draft_id, Draft.version == version]
            if action == "cancel":
                conditions.append(Draft.status.in_(["pending", "editing"]))
            else:
                conditions.extend([Draft.status == "pending", Draft.expires_at > now()])
            values = {"status": target}
            if action == "publish":
                values["approved_at"] = now()
            result = await session.execute(update(Draft).where(*conditions).values(**values))
            if not result.rowcount:
                raise Conflict("მონახაზი მოძველდა ან მოქმედება უკვე შესრულებულია.")
            session.add(
                Audit(
                    draft_id=draft_id, action=action, actor=str(actor), details={"version": version}
                )
            )
            return await session.get(Draft, draft_id)

    async def replace_revision(self, draft_id, version, payload, actor):
        async with self.session.begin() as session:
            result = await session.execute(
                update(Draft)
                .where(
                    Draft.id == draft_id,
                    Draft.version == version,
                    Draft.status.in_(["pending", "editing"]),
                    Draft.expires_at > now(),
                )
                .values(
                    payload=payload,
                    version=version + 1,
                    status="pending",
                    approved_at=None,
                    owner_message_id=None,
                )
            )
            if not result.rowcount:
                raise Conflict("მონახაზი შეიცვალა ან ვადა გაუვიდა.")
            session.add(Revision(draft_id=draft_id, version=version + 1, payload=payload))
            session.add(
                Audit(
                    draft_id=draft_id,
                    action="revised",
                    actor=str(actor),
                    details={"version": version + 1},
                )
            )
            return await session.get(Draft, draft_id)

    async def editing_draft(self):
        async with self.session() as session:
            return list(
                (await session.scalars(select(Draft).where(Draft.status == "editing"))).all()
            )

    async def mark_notified(self, draft_id, version, message_id):
        async with self.session.begin() as session:
            await session.execute(
                update(Draft)
                .where(Draft.id == draft_id, Draft.version == version)
                .values(owner_message_id=message_id)
            )

    async def publication_result(self, draft_id, status, message_id=None):
        async with self.session.begin() as session:
            result = await session.execute(
                update(Draft)
                .where(
                    Draft.id == draft_id,
                    Draft.status == "publishing",
                )
                .values(
                    status=status,
                    message_id=message_id,
                    published_at=now() if status == "published" else None,
                )
            )
            if not result.rowcount:
                raise Conflict("Publication state changed")
            session.add(
                Audit(
                    draft_id=draft_id,
                    action=status,
                    actor="publisher",
                    details={"message_id": message_id},
                )
            )

    async def reconcile(self, draft_id, message_id, actor):
        """Owner supplies a channel message ID after checking an ambiguous send."""
        async with self.session.begin() as session:
            result = await session.execute(
                update(Draft)
                .where(
                    Draft.id == draft_id,
                    Draft.status == "unknown",
                )
                .values(status="published", message_id=message_id, published_at=now())
            )
            if not result.rowcount:
                raise Conflict("Only unknown publications may be reconciled")
            session.add(
                Audit(
                    draft_id=draft_id,
                    action="reconciled",
                    actor=str(actor),
                    details={"message_id": message_id},
                )
            )

    async def stats(self):
        async with self.session() as session:
            await session.execute(select(1))
            counts = dict(
                (
                    await session.execute(select(Draft.status, func.count()).group_by(Draft.status))
                ).all()
            )
            jobs = dict(
                (await session.execute(select(Job.status, func.count()).group_by(Job.status))).all()
            )
            heartbeat = await session.get(Heartbeat, "worker")
            usage = list(
                (await session.scalars(select(Usage).order_by(Usage.day.desc()).limit(7))).all()
            )
            return {
                "drafts": counts,
                "jobs": jobs,
                "worker_heartbeat": heartbeat.updated_at.isoformat() if heartbeat else None,
                "usage": [
                    {
                        k: getattr(row, k)
                        for k in (
                            "day",
                            "runs",
                            "calls",
                            "input_tokens",
                            "output_tokens",
                            "search_calls",
                        )
                    }
                    for row in usage
                ],
            }
