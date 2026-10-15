import http.client
import ipaddress
import re
import socket
import ssl
import unicodedata
from difflib import SequenceMatcher
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup


def normalize(text):
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", text).casefold()))


def canonical_url(url):
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise ValueError("Only public HTTPS URLs are accepted")
    if parts.port not in (None, 443):
        raise ValueError("Nonstandard ports are not allowed")
    if any(ord(c) < 33 for c in url) or "\\" in url:
        raise ValueError("Invalid URL characters")
    host = parts.hostname.lower().removeprefix("www.").encode("idna").decode()
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None or "." not in host or host.endswith((".local", ".internal")):
        raise ValueError("IP literals and internal hosts are not accepted")
    query = [
        (k, v)
        for k, v in parse_qsl(parts.query)
        if not k.lower().startswith("utm_") and k.lower() not in {"fbclid", "gclid"}
    ]
    return urlunsplit(("https", host, parts.path or "/", urlencode(sorted(query)), ""))


def allowed_url(url, domains):
    host = urlsplit(canonical_url(url)).hostname
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def public_addresses(host):
    addresses = list(
        dict.fromkeys(item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM))
    )
    if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
        raise ValueError("Private or reserved destination rejected")
    return addresses


class PinnedHTTPS(http.client.HTTPSConnection):
    """Resolve once, validate all answers, connect to that IP, preserve TLS SNI."""

    def connect(self):
        address = public_addresses(self.host)[0]
        sock = socket.create_connection((address, 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


def fetch_public(url, domains, max_bytes=1_000_000, allowed_types=("text/html",)):
    for _ in range(4):
        url = canonical_url(url)
        if not allowed_url(url, domains):
            raise ValueError("Destination outside configured domains")
        parts = urlsplit(url)
        connection = PinnedHTTPS(parts.hostname, timeout=12, context=ssl.create_default_context())
        try:
            path = parts.path + ("?" + parts.query if parts.query else "")
            connection.request(
                "GET",
                path,
                headers={
                    "User-Agent": "PoliticalNewsroom/0.1 (source verification)",
                    "Accept-Encoding": "identity",
                },
            )
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    raise ValueError("Redirect without location")
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise ValueError(f"Source returned HTTP {response.status}")
            content_type = (response.getheader("Content-Type") or "").split(";")[0].lower()
            if content_type not in allowed_types:
                raise ValueError("Unsupported content type")
            data = response.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise ValueError("Response exceeds size limit")
            return data, content_type, url
        finally:
            connection.close()
    raise ValueError("Too many redirects")


def fetch_article(url, domains):
    data, _, final_url = fetch_public(url, domains)
    soup = BeautifulSoup(data, "html.parser")
    for item in soup(["script", "style", "nav", "footer", "header", "aside"]):
        item.decompose()
    text = " ".join((soup.find("article") or soup.find("main") or soup).stripped_strings)
    if len(text) < 300:
        raise ValueError("Not enough source text to verify")
    return {"url": canonical_url(url), "final_url": final_url, "text": text[:22000]}


def duplicate(candidate, history):
    key, topic = normalize(candidate.event_key), normalize(candidate.topic)
    urls = {canonical_url(url) for url in candidate.source_urls}
    for previous in history:
        old_urls = {x["url"] for x in previous.payload.get("sources", [])}
        if key == normalize(previous.event_key) or urls & old_urls:
            return "same event or source article"
        old = normalize(previous.topic)
        a, b = set(topic.split()), set(old.split())
        if a and b and len(a & b) / min(len(a), len(b)) >= 0.8:
            return "overlapping event/topic; human review required"
        if SequenceMatcher(None, topic, old).ratio() >= 0.85:
            return "near-identical topic"
    return None


def telegram_length(text):
    return len(text.encode("utf-16-le")) // 2


def validate_article(article, post_format, limits):
    if not article.title.strip() or not article.body.strip():
        raise ValueError("Empty article")
    if re.search(r"https?://|<[^>]+>", article.title + article.body):
        raise ValueError("Links belong in source buttons, not generated article text")
    if not re.search(r"[\u10a0-\u10ff]", article.body):
        raise ValueError("Georgian text required")
    if telegram_length(article.title + "\n\n" + article.body) > 3500:
        raise ValueError("Article exceeds safe single-message length")
    if post_format in limits:
        low, high = limits[post_format]
        if not low <= len(article.body.split()) <= high:
            raise ValueError("Article outside configured word limits")
