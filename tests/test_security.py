import json
import socket
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from political_agent.app import create_app
from political_agent.config import Settings
from political_agent.safety import allowed_url, canonical_url, public_addresses, telegram_length
from political_agent.telegram import Telegram, TelegramAmbiguous, TelegramRejected


@pytest.fixture
async def client(settings, store):
    app = create_app(settings, store, telegram=AsyncMock(), llm=AsyncMock())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", trust_env=False
    ) as client:
        yield client


def owner_update(settings, update_id=1, actor=None):
    return {
        "update_id": update_id,
        "callback_query": {
            "id": "q1",
            "from": {"id": actor or settings.owner_chat_id},
            "message": {"message_id": 9, "chat": {"id": settings.owner_chat_id, "type": "private"}},
            "data": "p:" + "a" * 32 + ":1",
        },
    }


async def test_webhook_secret_required(client, settings):
    for secret in ("", "x" * 40):
        response = await client.post(
            "/telegram/webhook",
            json=owner_update(settings),
            headers={"X-Telegram-Bot-Api-Secret-Token": secret},
        )
        assert response.status_code == 401


async def test_foreign_user_is_not_queued(client, store, settings):
    response = await client.post(
        "/telegram/webhook",
        json=owner_update(settings, actor=999),
        headers={"X-Telegram-Bot-Api-Secret-Token": "s" * 40},
    )
    assert response.status_code == 200
    assert await store.take_job() is None


async def test_webhook_durable_queue_and_replay(client, store, settings):
    responses = [
        await client.post(
            "/telegram/webhook",
            json=owner_update(settings),
            headers={"X-Telegram-Bot-Api-Secret-Token": "s" * 40},
        )
        for _ in range(2)
    ]
    assert responses[0].json()["job_id"] == responses[1].json()["job_id"]
    assert (await store.take_job()).payload["update_id"] == 1
    assert await store.take_job() is None


@pytest.mark.parametrize(
    "data", [{}, {"update_id": True}, {"update_id": -1}, {"update_id": "1"}, [], "oops"]
)
async def test_malformed_updates_rejected(client, data):
    response = await client.post(
        "/telegram/webhook", json=data, headers={"X-Telegram-Bot-Api-Secret-Token": "s" * 40}
    )
    assert response.status_code == 400


async def test_webhook_limits_body_size(client):
    response = await client.post(
        "/telegram/webhook",
        content=b"x" * 262145,
        headers={"X-Telegram-Bot-Api-Secret-Token": "s" * 40},
    )
    assert response.status_code == 413


async def test_worker_disabled_returns_retryable_status(client, settings):
    settings.worker_enabled = False
    response = await client.post(
        "/telegram/webhook",
        json=owner_update(settings),
        headers={"X-Telegram-Bot-Api-Secret-Token": "s" * 40},
    )
    assert response.status_code == 503


async def test_admin_api_is_authenticated(client):
    assert (await client.get("/admin/status")).status_code == 401
    assert (
        await client.get("/admin/status", headers={"Authorization": "Bearer wrong"})
    ).status_code == 401
    response = await client.get("/admin/status", headers={"Authorization": "Bearer " + "a" * 40})
    assert response.status_code == 200
    assert "offline-test-key" not in response.text
    assert "offline-test-token" not in response.text


async def test_no_unauthenticated_publish_endpoint(client):
    assert (await client.post("/publish")).status_code == 404
    assert (await client.get("/docs")).status_code == 404


async def test_ready_distinguishes_live_and_operational(client):
    assert (await client.get("/health")).status_code == 200
    assert (await client.get("/ready")).status_code == 503


@pytest.mark.parametrize(
    "url",
    [
        "http://alpha.example/a",
        "https://127.0.0.1/a",
        "https://[::1]/",
        "https://localhost/",
        "https://u:p@alpha.example/",
        "https://alpha.example:8080/",
        "https://server.internal/",
        "https://alpha.example/a\nX:bad",
    ],
)
def test_unsafe_urls_rejected(url):
    with pytest.raises(ValueError):
        canonical_url(url)


def test_domain_allowlist_is_not_suffix_confused():
    assert allowed_url("https://news.alpha.example/a", {"alpha.example"})
    assert not allowed_url("https://evilalpha.example/a", {"alpha.example"})
    assert not allowed_url("https://alpha.example.evil.test/a", {"alpha.example"})


@pytest.mark.parametrize(
    "ip", ["127.0.0.1", "10.0.0.2", "169.254.169.254", "::1", "fc00::1", "0.0.0.0"]
)
def test_dns_private_addresses_blocked(monkeypatch, ip):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))],
    )
    with pytest.raises(ValueError):
        public_addresses("alpha.example")


def test_mixed_public_private_dns_blocked(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *a, **k: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))
            for ip in ("8.8.8.8", "127.0.0.1")
        ],
    )
    with pytest.raises(ValueError):
        public_addresses("alpha.example")


def test_unicode_telegram_limit():
    assert telegram_length("ა😀") == 3


def test_production_requires_postgres():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, app_env="production", admin_api_token="a" * 40)


def test_existing_tech_channel_protected():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, channel_id="@Cifruli_Era")


def test_token_requires_secret_and_owner():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, telegram_bot_token="test")


def test_schedule_requires_explicit_settings():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, scheduler_enabled=True, worker_enabled=True)


@pytest.mark.parametrize(
    "status,payload,error",
    [
        (200, {"ok": False, "error_code": 403}, TelegramRejected),
        (429, {"ok": False, "error_code": 429}, TelegramRejected),
        (500, {}, TelegramAmbiguous),
    ],
)
async def test_telegram_failure_classification(settings, status, payload, error):
    transport = httpx.MockTransport(lambda request: httpx.Response(status, json=payload))
    async with httpx.AsyncClient(transport=transport) as client:
        telegram = Telegram(settings, client)
        with pytest.raises(error):
            await telegram.message("სატესტო ტექსტი")


async def test_telegram_timeout_is_ambiguous(settings):
    def timeout(request):
        raise httpx.ReadTimeout("token-containing-url-must-not-be-returned")

    async with httpx.AsyncClient(transport=httpx.MockTransport(timeout)) as client:
        with pytest.raises(TelegramAmbiguous) as result:
            await Telegram(settings, client).message("სატესტო ტექსტი")
    assert "offline-test-token" not in str(result.value)


async def test_source_link_and_single_send_delivery(settings):
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 2}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await Telegram(settings, client).message(
            "სატესტო ტექსტი", [[{"text": "წყარო", "url": "https://alpha.example/a"}]], "@test"
        )
    assert len(requests) == 1
    assert requests[0]["reply_markup"]["inline_keyboard"][0][0]["url"] == "https://alpha.example/a"


async def test_wrong_bot_identity_is_rejected(settings):
    settings.expected_bot_username = "political_test_bot"
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, json={"ok": True, "result": {"id": 1, "username": "different_bot"}}
        )
    )
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(TelegramRejected):
            await Telegram(settings, client).verify_identity()


async def test_numeric_tech_channel_cannot_bypass_identity_check(settings):
    settings.expected_bot_username = "political_test_bot"
    settings.channel_id = "-10012345678"

    def handle(request):
        result = (
            {"id": 1, "username": "political_test_bot"}
            if request.url.path.endswith("getMe")
            else {"type": "channel", "username": "Cifruli_Era"}
        )
        return httpx.Response(200, json={"ok": True, "result": result})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(TelegramRejected):
            await Telegram(settings, client).verify_identity(check_channel=True)
