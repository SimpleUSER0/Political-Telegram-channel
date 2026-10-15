import argparse
import asyncio
import json
from urllib.parse import urlsplit

import uvicorn
from alembic import command
from alembic.config import Config

from .config import Settings
from .telegram import Telegram


async def register_webhook(settings):
    base = settings.public_base_url.rstrip("/")
    if urlsplit(base).scheme != "https" or not urlsplit(base).hostname:
        raise ValueError("PUBLIC_BASE_URL must be the independent service's HTTPS URL")
    telegram = Telegram(settings)
    try:
        identity = await telegram.verify_identity(check_channel=settings.publishing_enabled)
        await telegram.call(
            "setWebhook",
            {
                "url": base + "/telegram/webhook",
                "secret_token": settings.telegram_webhook_secret.get_secret_value(),
                "allowed_updates": ["message", "callback_query"],
                "drop_pending_updates": False,
            },
        )
        result = await telegram.call("getWebhookInfo", {})
        if result.get("url") != base + "/telegram/webhook":
            raise RuntimeError("Webhook registration was not verified")
        print(
            json.dumps(
                {
                    "webhook_registered": True,
                    "bot": identity.get("username"),
                    "pending_updates": result.get("pending_update_count"),
                },
                ensure_ascii=False,
            )
        )
    finally:
        await telegram.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["serve", "migrate", "doctor", "register-webhook"])
    args = parser.parse_args()
    settings = Settings()
    if args.command == "serve":
        import os

        from .app import create_app

        uvicorn.run(
            create_app(settings),
            host="0.0.0.0",
            port=int(os.getenv("PORT", "8080")),
            access_log=False,
        )
    elif args.command == "migrate":
        command.upgrade(Config("alembic.ini"), "head")
    elif args.command == "register-webhook":
        asyncio.run(register_webhook(settings))
    else:
        print(
            json.dumps(
                {
                    "environment": settings.app_env,
                    "missing_research_config": settings.research_missing(),
                    "telegram_configured": bool(settings.telegram_bot_token.get_secret_value()),
                    "worker_enabled": settings.worker_enabled,
                    "scheduler_enabled": settings.scheduler_enabled,
                    "publishing_enabled": settings.publishing_enabled,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
