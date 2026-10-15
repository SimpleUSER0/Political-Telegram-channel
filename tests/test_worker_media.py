import hashlib
import json
from unittest.mock import AsyncMock
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.exc import IntegrityError

from political_agent.media import CommonsMedia
from political_agent.models import now
from political_agent.telegram import ApprovalService
from political_agent.worker import Worker


async def test_same_event_cannot_be_saved_twice(store, candidate, payload):
    await store.create_draft(candidate, payload)
    with pytest.raises(IntegrityError):
        await store.create_draft(candidate, payload)


async def test_scheduler_catches_short_delay_once(settings, store, monkeypatch):
    stamp = now().astimezone(ZoneInfo(settings.timezone)).replace(hour=13, minute=7)
    settings.scheduler_enabled = True
    settings.schedule_times = "13:00"
    monkeypatch.setattr("political_agent.worker.now", lambda: stamp)
    worker = Worker(settings, store, AsyncMock(), AsyncMock())
    await worker.schedule()
    await worker.schedule()
    assert (await store.take_job()).kind == "generate"
    assert await store.take_job() is None


async def test_scheduler_does_not_backfill_old_news(settings, store, monkeypatch):
    stamp = now().astimezone(ZoneInfo(settings.timezone)).replace(hour=13, minute=30)
    settings.scheduler_enabled = True
    settings.schedule_times = "13:00"
    monkeypatch.setattr("political_agent.worker.now", lambda: stamp)
    await Worker(settings, store, AsyncMock(), AsyncMock()).schedule()
    assert await store.take_job() is None


async def test_worker_finishes_generation_job(settings, store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    newsroom, approval = AsyncMock(), AsyncMock()
    newsroom.generate.return_value = draft
    await store.enqueue("generate", {"query": "offline", "post_format": "STANDARD"})
    await Worker(settings, store, newsroom, approval).step()
    assert (await store.stats())["jobs"] == {"done": 1}
    approval.notify.assert_awaited_once_with(draft)


async def test_worker_failure_stores_safe_error_and_does_not_retry(settings, store):
    newsroom, approval = AsyncMock(), AsyncMock()
    newsroom.generate.side_effect = RuntimeError("secret-value-not-for-logs")
    await store.enqueue("generate", {"query": "offline", "post_format": "STANDARD"})
    worker = Worker(settings, store, newsroom, approval)
    await worker.step()
    await worker.step()
    assert (await store.stats())["jobs"] == {"failed": 1}
    newsroom.generate.assert_awaited_once()


async def test_callback_requires_matching_owner_message(settings, store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    await store.mark_notified(draft.id, 1, 55)
    telegram = AsyncMock()
    approval = ApprovalService(settings, store, telegram, AsyncMock(), AsyncMock())
    await approval.process_update(
        {
            "update_id": 1,
            "callback_query": {
                "id": "test",
                "from": {"id": settings.owner_chat_id},
                "data": f"p:{draft.id}:1",
                "message": {
                    "message_id": 99,
                    "chat": {"id": settings.owner_chat_id, "type": "private"},
                },
            },
        }
    )
    assert (await store.get_draft(draft.id)).status == "pending"
    telegram.message.assert_not_awaited()


async def test_plain_text_never_bypasses_approval(settings, store):
    telegram = AsyncMock()
    approval = ApprovalService(settings, store, telegram, AsyncMock(), AsyncMock())
    await approval.process_update(
        {
            "update_id": 1,
            "message": {
                "from": {"id": settings.owner_chat_id},
                "chat": {"id": settings.owner_chat_id, "type": "private"},
                "text": "სტატია\nწყარო: https://alpha.example/a",
            },
        }
    )
    assert telegram.message.call_args.args[0].endswith("ავტომატურად არ ქვეყნდება.")
    assert "@independent_political_test" not in str(telegram.message.call_args)


async def test_commons_rejects_unlicensed_image(monkeypatch):
    response = {
        "query": {
            "pages": {
                "1": {
                    "imageinfo": [
                        {
                            "url": "https://upload.wikimedia.org/test.jpg",
                            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Test.jpg",
                            "mime": "image/jpeg",
                            "extmetadata": {
                                "License": {"value": "all-rights-reserved"},
                                "Artist": {"value": "Test"},
                            },
                        }
                    ]
                }
            }
        }
    }
    monkeypatch.setattr(
        "political_agent.media.fetch_public",
        lambda *a, **k: (json.dumps(response).encode(), "application/json", "url"),
    )
    assert await CommonsMedia().find("fictional test") is None


async def test_commons_stores_license_and_hash(monkeypatch):
    content = b"\xff\xd8\xff" + b"x" * 100
    response = {
        "query": {
            "pages": {
                "1": {
                    "imageinfo": [
                        {
                            "url": "https://upload.wikimedia.org/test.jpg",
                            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Test.jpg",
                            "mime": "image/jpeg",
                            "extmetadata": {
                                "License": {"value": "cc-by-4.0"},
                                "Artist": {"value": "<b>Author</b>"},
                            },
                        }
                    ]
                }
            }
        }
    }

    def fetch(url, *a, **k):
        return (
            (json.dumps(response).encode(), "application/json", url)
            if "api.php" in url
            else (content, "image/jpeg", url)
        )

    monkeypatch.setattr("political_agent.media.fetch_public", fetch)
    image = await CommonsMedia().find("fictional test")
    assert image["author"] == "Author" and image["license"] == "cc-by-4.0"
    assert image["sha256"] == hashlib.sha256(content).hexdigest()
    assert "საარქივო" in image["context"]


async def test_changed_photo_is_blocked(monkeypatch):
    content = b"\xff\xd8\xff" + b"changed"
    monkeypatch.setattr(
        "political_agent.media.fetch_public", lambda *a, **k: (content, "image/jpeg", "url")
    )
    with pytest.raises(ValueError):
        await CommonsMedia().download(
            {"url": "https://upload.wikimedia.org/test.jpg", "sha256": "old"}
        )


async def test_cancellation_during_publish_does_not_reset_pending(
    settings, store, candidate, payload
):
    import asyncio

    draft = await store.create_draft(candidate, payload)
    telegram = AsyncMock()
    telegram.message.side_effect = asyncio.CancelledError()
    approval = ApprovalService(settings, store, telegram, AsyncMock(), AsyncMock())
    with pytest.raises(asyncio.CancelledError):
        await approval.publish(draft.id, 1, settings.owner_chat_id)
    assert (await store.get_draft(draft.id)).status == "unknown"


async def test_notify_buttons_reference_saved_revision(settings, store, candidate, payload):
    draft = await store.create_draft(candidate, payload)
    telegram = AsyncMock()
    telegram.message.return_value = {"message_id": 44}
    approval = ApprovalService(settings, store, telegram, AsyncMock(), AsyncMock())
    await approval.notify(draft)
    buttons = telegram.message.call_args.args[1]
    assert buttons[-1][0]["callback_data"] == f"p:{draft.id}:1"
    assert buttons[0][0]["url"] == payload["sources"][0]["url"]
    assert (await store.get_draft(draft.id)).owner_message_id == 44


async def test_job_lane_keeps_approval_separate_from_research(store):
    await store.enqueue("generate", {"query": "offline", "post_format": "STANDARD"})
    telegram_id = await store.enqueue("telegram", {"update_id": 99})
    job = await store.take_job(["telegram", "edit", "notify"])
    assert job.id == telegram_id
    assert (await store.take_job(["generate"])).kind == "generate"
