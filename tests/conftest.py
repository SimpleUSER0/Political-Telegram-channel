import os

import pytest
from sqlalchemy import delete

from political_agent.config import Settings
from political_agent.db import Store
from political_agent.models import Base, now
from political_agent.schemas import (
    Article,
    Candidate,
    Claim,
    Evidence,
    SourceAssessment,
    Verification,
)


@pytest.fixture
def settings(tmp_path):
    url = os.getenv("TEST_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path}/test.db")
    if "postgres" in url:
        assert url.rsplit("/", 1)[-1].endswith("_test"), (
            "Tests must use a dedicated *_test database"
        )
    return Settings(
        _env_file=None,
        database_url=url,
        admin_api_token="a" * 40,
        openai_api_key="offline-test-key",
        openai_model="test-model",
        source_domains="alpha.example,beta.example",
        telegram_bot_token="offline-test-token",
        telegram_webhook_secret="s" * 40,
        owner_chat_id=12345,
        channel_id="@independent_political_test",
        commons_enabled=False,
        worker_enabled=True,
        publishing_enabled=True,
    )


@pytest.fixture
async def store(settings):
    db = Store(settings)
    await db.create_schema()
    async with db.session.begin() as session:
        for table in reversed(Base.metadata.sorted_tables):
            await session.execute(delete(table))
    yield db
    await db.engine.dispose()


@pytest.fixture
def candidate():
    return Candidate(
        event_key="2026-10-15 fictional parliamentary vote",
        topic="გამოგონილი ქვეყნის პარლამენტის სატესტო კენჭისყრა",
        category="world",
        event_at=now(),
        importance=70,
        selection_reason="Offline fixture only",
        source_urls=["https://alpha.example/news/vote", "https://beta.example/politics/vote"],
        image_query="",
    )


@pytest.fixture
def payload(candidate):
    excerpt = "The fictional parliament voted on the proposed bill today."
    sources = [
        {"id": i, "url": url, "final_url": url, "text": excerpt + " Background " * 40}
        for i, url in enumerate(candidate.source_urls)
    ]
    packet = Verification(
        sources=[
            SourceAssessment(
                source_id=i,
                published_at=now(),
                publisher=f"publisher-{i}",
                origin_group=f"origin-{i}",
                kind="independent",
                reliability_note="test",
            )
            for i in range(2)
        ],
        claims=[
            Claim(
                text="გამოგონილმა პარლამენტმა კანონპროექტს კენჭი უყარა.",
                status="verified",
                attribution="",
                origin_groups=["origin-0", "origin-1"],
                evidence=[Evidence(source_id=i, excerpt=excerpt) for i in range(2)],
            )
        ],
        contradictions=[],
        publishable=True,
        reason="Offline fixture",
    )
    article = Article(
        title="სატესტო კენჭისყრა",
        body="გამოგონილმა პარლამენტმა კანონპროექტს კენჭი უყარა.",
        claim_ids=[0],
        source_ids=[0, 1],
    )
    return {
        "article": article.model_dump(),
        "verification": packet.model_dump(mode="json"),
        "sources": sources,
        "image": None,
        "post_format": "STANDARD",
        "selection": candidate.model_dump(mode="json"),
        "checked_at": now().isoformat(),
    }
