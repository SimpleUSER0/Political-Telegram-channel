import asyncio
import hashlib
import json
import logging
from urllib.parse import urlencode

from bs4 import BeautifulSoup

from .safety import fetch_public

logger = logging.getLogger(__name__)
LICENSES = {"cc0", "cc-by-4.0", "cc-by-sa-4.0", "cc-by-3.0", "cc-by-sa-3.0", "pd"}


def plain(value):
    return BeautifulSoup(value or "", "html.parser").get_text(" ", strip=True)


class CommonsMedia:
    """Only licensed Wikimedia Commons still images; never synthesize a political scene."""

    async def find(self, query):
        if not query.strip():
            return None
        params = {
            "action": "query",
            "format": "json",
            "generator": "search",
            "gsrsearch": query[:180] + " filetype:bitmap",
            "gsrnamespace": "6",
            "gsrlimit": "3",
            "prop": "imageinfo",
            "iiprop": "url|extmetadata|mime|size",
            "iiurlwidth": "1280",
        }
        try:
            raw, _, _ = await asyncio.to_thread(
                fetch_public,
                "https://commons.wikimedia.org/w/api.php?" + urlencode(params),
                {"commons.wikimedia.org"},
                500000,
                ("application/json",),
            )
            data = json.loads(raw)
            for page in data.get("query", {}).get("pages", {}).values():
                info = (page.get("imageinfo") or [{}])[0]
                metadata = info.get("extmetadata", {})
                license_name = metadata.get("License", {}).get("value", "").lower()
                author = plain(metadata.get("Artist", {}).get("value", ""))[:200]
                if (
                    license_name not in LICENSES
                    or not author
                    or info.get("mime") not in {"image/jpeg", "image/png"}
                ):
                    continue
                image_url = info.get("thumburl") or info.get("url", "")
                if not image_url.startswith("https://upload.wikimedia.org/"):
                    continue
                image = {
                    "url": image_url,
                    "page_url": info["descriptionurl"],
                    "author": author,
                    "license": license_name,
                    "license_url": metadata.get("LicenseUrl", {}).get("value", ""),
                    "description": plain(metadata.get("ImageDescription", {}).get("value", ""))[
                        :500
                    ],
                    "context": "საილუსტრაციო/საარქივო ფოტო; მოვლენის ამსახველ ფოტოდ არ დასტურდება.",
                }
                content, _ = await self.download(image)
                image["sha256"] = hashlib.sha256(content).hexdigest()
                return image
        except Exception as error:
            logger.info("commons_unavailable", extra={"reason": type(error).__name__})
        return None

    async def download(self, image):
        data, mime, _ = await asyncio.to_thread(
            fetch_public,
            image["url"],
            {"upload.wikimedia.org"},
            8_000_000,
            ("image/jpeg", "image/png"),
        )
        if not (data.startswith(b"\xff\xd8\xff") or data.startswith(b"\x89PNG\r\n\x1a\n")):
            raise ValueError("Invalid image signature")
        if image.get("sha256") and hashlib.sha256(data).hexdigest() != image["sha256"]:
            raise ValueError("Image changed since the draft was created")
        return data, mime
