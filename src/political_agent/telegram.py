import re

import httpx

from .db import Conflict
from .models import now
from .safety import telegram_length
from .schemas import Article, Verification


class TelegramRejected(RuntimeError):
    """Telegram definitively rejected the operation; no successful send was acknowledged."""


class TelegramAmbiguous(RuntimeError):
    """Transport/server error: it is unsafe to assume a message was not sent."""


class Telegram:
    def __init__(self, settings, client=None):
        self.settings = settings
        self.client = client or httpx.AsyncClient(timeout=25, trust_env=False)

    async def close(self):
        await self.client.aclose()

    async def verify_identity(self, check_channel=False):
        identity = await self.call("getMe", {})
        expected = self.settings.expected_bot_username.lstrip("@").casefold()
        if not expected or identity.get("username", "").casefold() != expected:
            raise TelegramRejected("Bot identity does not match EXPECTED_BOT_USERNAME")
        if check_channel:
            channel = await self.call("getChat", {"chat_id": self.settings.channel_id})
            if (
                channel.get("type") != "channel"
                or channel.get("username", "").casefold() == "cifruli_era"
            ):
                raise TelegramRejected("An independent political channel is required")
            membership = await self.call(
                "getChatMember", {"chat_id": self.settings.channel_id, "user_id": identity["id"]}
            )
            if membership.get("status") != "administrator" or not membership.get(
                "can_post_messages"
            ):
                raise TelegramRejected("Bot lacks channel posting permission")
        return identity

    async def call(self, method, payload, photo=None):
        token = self.settings.telegram_bot_token.get_secret_value()
        if not token:
            raise TelegramRejected("Telegram is not configured")
        url = f"https://api.telegram.org/bot{token}/{method}"
        try:
            if photo:
                import json

                data = {
                    key: json.dumps(value) if isinstance(value, (dict, list)) else str(value)
                    for key, value in payload.items()
                }
                response = await self.client.post(
                    url, data=data, files={"photo": ("news.jpg", photo[0], photo[1])}
                )
            else:
                response = await self.client.post(url, json=payload)
            if response.status_code >= 500:
                raise TelegramAmbiguous("Telegram server error; check channel before retry")
            result = response.json()
            if not result.get("ok"):
                code = result.get("error_code", response.status_code)
                raise TelegramRejected(f"Telegram rejected operation ({code})")
            return result["result"]
        except (httpx.HTTPError, ValueError) as error:
            raise TelegramAmbiguous("Telegram response unknown; check before retry") from error

    async def message(self, text, keyboard=None, chat_id=None):
        payload = {
            "chat_id": chat_id or self.settings.owner_chat_id,
            "text": text,
            "link_preview_options": {"is_disabled": True},
        }
        if keyboard:
            payload["reply_markup"] = {"inline_keyboard": keyboard}
        return await self.call("sendMessage", payload)

    async def answer(self, query_id, text):
        try:
            await self.call(
                "answerCallbackQuery", {"callback_query_id": query_id, "text": text[:180]}
            )
        except (TelegramRejected, TelegramAmbiguous):
            pass  # Answering a stale callback must never replay publication.

    async def remove_keyboard(self, message_id):
        if not message_id:
            return
        try:
            await self.call(
                "editMessageReplyMarkup",
                {
                    "chat_id": self.settings.owner_chat_id,
                    "message_id": message_id,
                    "reply_markup": {"inline_keyboard": []},
                },
            )
        except (TelegramRejected, TelegramAmbiguous):
            pass


def source_buttons(payload):
    selected = set(payload["article"]["source_ids"])
    return [
        [{"text": f"წყარო {source['id'] + 1}", "url": source["url"]}]
        for source in payload["sources"]
        if source["id"] in selected
    ]


def delivery_text(draft):
    article, image = draft.payload["article"], draft.payload.get("image")
    text = article["title"].strip() + "\n\n" + article["body"].strip()
    if image:
        caption = (
            text
            + "\n\n"
            + image["context"]
            + "\nფოტო: "
            + image["author"]
            + " / "
            + image["license"]
        )
        if telegram_length(caption) <= 1024:
            return caption, True
    return text, False  # One Telegram send per publication, including long articles.


class ApprovalService:
    def __init__(self, settings, store, telegram, newsroom, media):
        self.settings, self.store, self.telegram = settings, store, telegram
        self.newsroom, self.media = newsroom, media

    async def notify(self, draft):
        from datetime import UTC

        expires_at = draft.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        if draft.status != "pending" or expires_at <= now():
            raise Conflict("საჭიროა მოქმედი, მოლოდინში მყოფი მონახაზი.")
        text, use_photo = delivery_text(draft)
        keyboard = source_buttons(draft.payload)
        image = draft.payload.get("image")
        if use_photo and image:
            keyboard.append([{"text": "ფოტო / ლიცენზია", "url": image["page_url"]}])
        keyboard.append(
            [
                {"text": "Publish", "callback_data": f"p:{draft.id}:{draft.version}"},
                {"text": "Edit", "callback_data": f"e:{draft.id}:{draft.version}"},
                {"text": "Cancel", "callback_data": f"c:{draft.id}:{draft.version}"},
            ]
        )
        packet = Verification.model_validate(draft.payload["verification"])
        notes = [
            f"მონახაზი {draft.id} · v{draft.version} · {draft.post_format}",
            f"ვადა: {draft.expires_at.isoformat()}",
            "შემოწმება ავტომატურია; წყაროები და კონტექსტი გადაამოწმე დამტკიცებამდე.",
        ]
        notes.extend(f"• {claim.status}: {claim.text[:180]}" for claim in packet.claims[:8])
        notes.extend(f"⚠ {item[:200]}" for item in packet.contradictions[:4])
        notes.append("გამოქვეყნება: " + ("ფოტო და ტექსტი" if use_photo else "ტექსტური პოსტი"))
        await self.telegram.message("\n".join(notes)[:3000])
        if use_photo:
            photo = await self.media.download(image)
            result = await self.telegram.call(
                "sendPhoto",
                {
                    "chat_id": self.settings.owner_chat_id,
                    "caption": text,
                    "reply_markup": {"inline_keyboard": keyboard},
                },
                photo,
            )
        else:
            result = await self.telegram.message(text, keyboard)
        await self.store.mark_notified(draft.id, draft.version, result["message_id"])
        return result["message_id"]

    async def publish(self, draft_id, version, actor):
        if not self.settings.publishing_enabled:
            raise Conflict("გამოქვეყნება გამორთულია: PUBLISHING_ENABLED=false")
        if actor != self.settings.owner_chat_id:
            raise Conflict("Unauthorized")
        draft = await self.store.get_draft(draft_id)
        if draft is None:
            raise Conflict("Unknown draft")
        # Recheck the evidence's age and deterministic constraints immediately before sending.
        from .newsroom import check_verification
        from .safety import validate_article

        packet = Verification.model_validate(draft.payload["verification"])
        check_verification(packet, draft.payload["sources"], self.settings)
        validate_article(
            Article.model_validate(draft.payload["article"]),
            draft.post_format,
            self.settings.format_word_limits,
        )
        text, use_photo = delivery_text(draft)
        photo = await self.media.download(draft.payload["image"]) if use_photo else None
        draft = await self.store.transition(draft_id, version, "publish", actor)
        keyboard = source_buttons(draft.payload)
        if use_photo:
            keyboard.append(
                [{"text": "ფოტო / ლიცენზია", "url": draft.payload["image"]["page_url"]}]
            )
        try:
            if use_photo:
                result = await self.telegram.call(
                    "sendPhoto",
                    {
                        "chat_id": self.settings.channel_id,
                        "caption": text,
                        "reply_markup": {"inline_keyboard": keyboard},
                    },
                    photo,
                )
            else:
                result = await self.telegram.message(text, keyboard, self.settings.channel_id)
        except TelegramRejected:
            await self.store.publication_result(draft_id, "failed")
            raise
        except BaseException:
            # Includes cancellation during shutdown/timeouts. A crash before this write leaves
            # 'publishing', which recovery later marks 'unknown', never 'pending'.
            await self.store.publication_result(draft_id, "unknown")
            raise
        await self.store.publication_result(draft_id, "published", result["message_id"])
        await self.telegram.remove_keyboard(draft.owner_message_id)
        return result["message_id"]

    async def process_update(self, data):
        owner = self.settings.owner_chat_id
        if query := data.get("callback_query"):
            message = query.get("message") or {}
            if (
                query.get("from", {}).get("id") != owner
                or message.get("chat", {}).get("id") != owner
                or message.get("chat", {}).get("type") != "private"
            ):
                return
            match = re.fullmatch(r"([pec]):([a-f0-9]{32}):(\d{1,7})", query.get("data", ""))
            if not match:
                return
            action, draft_id, version = match[1], match[2], int(match[3])
            draft = await self.store.get_draft(draft_id)
            if not draft or draft.owner_message_id != message.get("message_id"):
                await self.telegram.answer(query["id"], "მონახაზის შეტყობინება მოძველდა.")
                return
            await self.telegram.answer(query["id"], "ვამუშავებ...")
            if action == "p":
                message_id = await self.publish(draft_id, version, owner)
                await self.telegram.message(f"გამოქვეყნდა. Channel message ID: {message_id}")
            elif action == "c":
                await self.store.transition(draft_id, version, "cancel", owner)
                await self.telegram.remove_keyboard(draft.owner_message_id)
                await self.telegram.message("მონახაზი გაუქმებულია.")
            else:
                await self.store.transition(draft_id, version, "edit", owner)
                await self.telegram.message(
                    f"მომწერე ამ ფორმით:\n/edit {draft_id}:{version}\nახალი სათაური\n\nახალი ტექსტი\n\n"
                    "რედაქტირების შემდეგ ახალი ვერსია ხელახლა შემოწმდება და დამტკიცებას მოითხოვს."
                )
            return
        message = data.get("message") or {}
        if (
            message.get("from", {}).get("id") != owner
            or message.get("chat", {}).get("id") != owner
            or message.get("chat", {}).get("type") != "private"
        ):
            return
        text = message.get("text", "").strip()
        command = text.split(maxsplit=1)[0].split("@")[0] if text else ""
        if command in {"/start", "/help"}:
            await self.telegram.message(
                "/news მოთხოვნა — ახალი მონახაზი\n/status — მდგომარეობა\n"
                "/pending — მოლოდინში მყოფი მონახაზები\n/show ID — მონახაზის ჩვენება\n"
                "/edit ID:VERSION — სათაური და ტექსტი შემდეგ ხაზებზე\n"
                "გამოქვეყნება მხოლოდ მონახაზის Publish ღილაკით ხდება."
            )
        elif command == "/news":
            query_text = (
                text.split(maxsplit=1)[1]
                if len(text.split(maxsplit=1)) > 1
                else "მნიშვნელოვანი ახალი პოლიტიკური მოვლენები"
            )
            if len(query_text) > 1000:
                raise ValueError("Query too long")
            if self.settings.research_missing():
                raise ValueError("Research credentials/model/source policy are not configured")
            job_id = await self.store.enqueue(
                "generate",
                {"query": query_text, "post_format": self.settings.default_format},
                key=f"telegram-news:{data['update_id']}",
            )
            await self.telegram.message(f"მოთხოვნა რიგშია: {job_id}")
        elif command == "/status":
            stats = await self.store.stats()
            await self.telegram.message(
                f"მონახაზები: {stats['drafts']}\nდავალებები: {stats['jobs']}\n"
                f"Worker: {stats['worker_heartbeat']}\nPublish enabled: {self.settings.publishing_enabled}\n"
                f"ბოლო ხარჯის მრიცხველები: {stats['usage'][:1]}"
            )
        elif command == "/pending":
            drafts = [d for d in await self.store.history() if d.status in {"pending", "editing"}]
            await self.telegram.message(
                "\n".join(f"{d.id} v{d.version} — {d.topic[:100]}" for d in drafts[:15])
                or "მოლოდინში მონახაზი არ არის."
            )
        elif command == "/show":
            parts = text.split()
            draft = await self.store.get_draft(parts[1]) if len(parts) == 2 else None
            if not draft or draft.status not in {"pending", "editing"}:
                raise Conflict("Pending draft not found")
            if draft.status == "editing":
                await self.telegram.message(
                    f"რედაქტირება მიმდინარეობს. გამოიყენე /edit {draft.id}:{draft.version}"
                )
                return
            await self.notify(draft)
        elif command == "/edit":
            match = re.fullmatch(
                r"/edit(?:@\w+)? ([a-f0-9]{32}):(\d{1,7})\n([^\n]+)\n\s*\n(.+)", text, re.S
            )
            if not match:
                raise ValueError("Use /edit ID:VERSION, newline title, blank line, body")
            draft = await self.store.get_draft(match[1])
            if not draft or draft.status not in {"pending", "editing"}:
                raise Conflict("Editable draft not found")
            revised = await self.newsroom.edit(draft, match[3], match[4], int(match[2]))
            await self.telegram.remove_keyboard(draft.owner_message_id)
            await self.notify(revised)
        elif text:
            await self.telegram.message(
                "გამოიყენე /news მოთხოვნა ან /help. მიღებული ტექსტი ავტომატურად არ ქვეყნდება."
            )
