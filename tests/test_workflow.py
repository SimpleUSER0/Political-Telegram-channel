import asyncio
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select, update

from political_agent.db import BudgetExceeded, Conflict
from political_agent.models import Audit, Draft, Job, Revision, now
from political_agent.newsroom import Newsroom
from political_agent.schemas import FactCheck
from political_agent.telegram import ApprovalService, TelegramAmbiguous, TelegramRejected


def service(settings, store, error=None):
    telegram = AsyncMock()
    telegram.message.return_value = {"message_id": 789}
    if error:
        telegram.message.side_effect = error
    newsroom = AsyncMock()
    return ApprovalService(settings, store, telegram, newsroom, AsyncMock())


async def test_publish_saves_approval_archive_and_audit(settings, store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    approval = service(settings, store)
    assert await approval.publish(draft.id, 1, settings.owner_chat_id) == 789
    row = await store.get_draft(draft.id)
    assert row.status == "published" and row.message_id == 789
    assert row.approved_at is not None and row.published_at is not None
    async with store.session() as session:
        actions = list(
            await session.scalars(select(Audit.action).where(Audit.draft_id == draft.id))
        )
    assert actions == ["created", "publish", "published"]


async def test_concurrent_double_click_sends_once(settings, store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    approval = service(settings, store)
    results = await asyncio.gather(
        *[approval.publish(draft.id, 1, settings.owner_chat_id) for _ in range(2)],
        return_exceptions=True,
    )
    assert sum(isinstance(x, Conflict) for x in results) == 1
    assert approval.telegram.message.await_count == 1


@pytest.mark.parametrize(
    "error,status", [(TelegramAmbiguous("timeout"), "unknown"), (TelegramRejected("403"), "failed")]
)
async def test_failed_send_is_never_replayed(settings, store, candidate, payload, error, status):
    draft = await store.create_draft(candidate, payload)
    approval = service(settings, store, error)
    with pytest.raises(type(error)):
        await approval.publish(draft.id, 1, settings.owner_chat_id)
    assert (await store.get_draft(draft.id)).status == status
    with pytest.raises(Conflict):
        await approval.publish(draft.id, 1, settings.owner_chat_id)
    assert approval.telegram.message.await_count == 1


async def test_database_failure_after_send_leaves_nonretryable_state(
    settings, store, candidate, payload, monkeypatch
):
    draft = await store.create_draft(candidate, payload)
    approval = service(settings, store)
    monkeypatch.setattr(store, "publication_result", AsyncMock(side_effect=RuntimeError("db")))
    with pytest.raises(RuntimeError):
        await approval.publish(draft.id, 1, settings.owner_chat_id)
    assert (await store.get_draft(draft.id)).status == "publishing"
    with pytest.raises(Conflict):
        await approval.publish(draft.id, 1, settings.owner_chat_id)
    assert approval.telegram.message.await_count == 1


async def test_cancel_blocks_publish(settings, store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    await store.transition(draft.id, 1, "cancel", settings.owner_chat_id)
    approval = service(settings, store)
    with pytest.raises(Conflict):
        await approval.publish(draft.id, 1, settings.owner_chat_id)
    approval.telegram.message.assert_not_awaited()
    assert await store.history() == []


async def test_expired_draft_never_sends(settings, store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    async with store.session.begin() as session:
        await session.execute(
            update(Draft)
            .where(Draft.id == draft.id)
            .values(expires_at=now() - timedelta(seconds=1))
        )
    approval = service(settings, store)
    with pytest.raises(Conflict):
        await approval.publish(draft.id, 1, settings.owner_chat_id)
    approval.telegram.message.assert_not_awaited()


async def test_publishing_disabled_preserves_pending(settings, store, candidate, payload):
    settings.publishing_enabled = False
    draft = await store.create_draft(candidate, payload)
    with pytest.raises(Conflict):
        await service(settings, store).publish(draft.id, 1, settings.owner_chat_id)
    assert (await store.get_draft(draft.id)).status == "pending"


async def test_foreign_actor_cannot_publish(settings, store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    approval = service(settings, store)
    with pytest.raises(Conflict):
        await approval.publish(draft.id, 1, 999)
    approval.telegram.message.assert_not_awaited()


async def test_revision_invalidates_old_approval(store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    await store.transition(draft.id, 1, "edit", "owner")
    revised = await store.replace_revision(draft.id, 1, payload, "owner")
    assert revised.version == 2 and revised.status == "pending"
    with pytest.raises(Conflict):
        await store.transition(draft.id, 1, "publish", "owner")
    async with store.session() as session:
        revisions = list(
            await session.scalars(select(Revision).where(Revision.draft_id == draft.id))
        )
    assert len(revisions) == 2


async def test_edit_uses_fact_checker_and_retains_history(settings, store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    llm = AsyncMock()
    llm.call.return_value = FactCheck(
        passed=True, unsupported_claims=[], missing_attributions=[], notes=[]
    )
    newsroom = Newsroom(settings, store, llm)
    revised = await newsroom.edit(draft, "განახლებული სათაური", payload["article"]["body"], 1)
    assert revised.version == 2
    llm.call.assert_awaited_once()


async def test_failed_fact_check_does_not_change_revision(settings, store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    llm = AsyncMock()
    llm.call.return_value = FactCheck(
        passed=False, unsupported_claims=["new allegation"], missing_attributions=[], notes=[]
    )
    with pytest.raises(ValueError):
        await Newsroom(settings, store, llm).edit(draft, "ცრუ სათაური", "გამოგონილი ბრალდება.", 1)
    assert (await store.get_draft(draft.id)).version == 1


async def test_restart_recovers_without_republishing(store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    await store.transition(draft.id, 1, "publish", "owner")
    old = now() - timedelta(hours=2)
    async with store.session.begin() as session:
        await session.execute(update(Draft).where(Draft.id == draft.id).values(approved_at=old))
        session.add(Job(kind="telegram", payload={}, status="running", started_at=old))
    await store.recover()
    assert (await store.get_draft(draft.id)).status == "unknown"
    assert await store.take_job() is None


async def test_reconcile_records_owner_supplied_message(store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    await store.transition(draft.id, 1, "publish", "owner")
    await store.publication_result(draft.id, "unknown")
    await store.reconcile(draft.id, 99, "owner")
    assert (await store.get_draft(draft.id)).message_id == 99


async def test_reconcile_cannot_mark_pending_as_published(store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    with pytest.raises(Conflict):
        await store.reconcile(draft.id, 99, "owner")


async def test_daily_budget_atomic(settings, store):
    settings.max_daily_api_calls = 2
    results = await asyncio.gather(
        *[store.reserve("calls") for _ in range(5)], return_exceptions=True
    )
    assert sum(isinstance(x, BudgetExceeded) for x in results) == 3
    assert (await store.stats())["usage"][0]["calls"] == 2


async def test_update_replay_returns_same_job(store):
    first = await store.enqueue("telegram", {"update_id": 42}, update_id=42)
    second = await store.enqueue("telegram", {"update_id": 42}, update_id=42)
    assert first == second
    job = await store.take_job()
    assert job.id == first
    assert await store.take_job() is None


async def test_two_workers_only_claim_once(store):
    await store.enqueue("generate", {"query": "test", "post_format": "STANDARD"})
    results = await asyncio.gather(store.take_job(), store.take_job())
    assert sum(x is not None for x in results) == 1
