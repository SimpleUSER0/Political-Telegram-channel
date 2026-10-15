from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from political_agent.models import now
from political_agent.newsroom import LLM, Newsroom, check_verification, retrieved_urls
from political_agent.safety import canonical_url, duplicate, validate_article
from political_agent.schemas import Article, Discovery, FactCheck, Verification
from political_agent.telegram import delivery_text


def test_valid_evidence_packet(settings, payload):
    check_verification(
        Verification.model_validate(payload["verification"]), payload["sources"], settings
    )


@pytest.mark.parametrize(
    "mutation",
    [
        "invented_quote",
        "single_origin",
        "missing_date",
        "old_date",
        "missing_attribution",
        "unknown_source",
        "unsupported_origin",
    ],
)
def test_invalid_evidence_is_blocked(settings, payload, mutation):
    packet = Verification.model_validate(payload["verification"])
    if mutation == "invented_quote":
        packet.claims[0].evidence[
            0
        ].excerpt = "This quote was invented and does not occur in the source."
    elif mutation == "single_origin":
        packet.sources[1].origin_group = "origin-0"
        packet.claims[0].origin_groups = ["origin-0"]
    elif mutation == "missing_date":
        packet.sources[0].published_at = None
    elif mutation == "old_date":
        packet.sources[0].published_at = now() - timedelta(days=30)
    elif mutation == "missing_attribution":
        packet.claims[0].status = "unverified"
    elif mutation == "unknown_source":
        packet.claims[0].evidence[0].source_id = 50
    elif mutation == "unsupported_origin":
        packet.claims[0].origin_groups = ["invented-group"]
    with pytest.raises(ValueError):
        check_verification(packet, payload["sources"], settings)


def test_operator_ownership_mapping_overrides_model(settings, payload):
    settings.source_origin_groups = {"alpha.example": "actual-owner"}
    with pytest.raises(ValueError):
        check_verification(
            Verification.model_validate(payload["verification"]), payload["sources"], settings
        )


def test_attributed_claim_is_allowed_without_becoming_verified(settings, payload):
    packet = Verification.model_validate(payload["verification"])
    packet.claims[0].status = "attributed"
    packet.claims[0].attribution = "პარლამენტის პრესსამსახურის ცნობით"
    packet.claims[0].evidence = packet.claims[0].evidence[:1]
    packet.claims[0].origin_groups = ["origin-0"]
    check_verification(packet, payload["sources"], settings)


def test_duplicate_canonical_urls(candidate, payload):
    previous = SimpleNamespace(event_key="different", topic="Other event", payload=payload)
    assert duplicate(candidate, [previous])
    assert (
        canonical_url("https://www.alpha.example/a?utm_source=x&b=2")
        == "https://alpha.example/a?b=2"
    )


def test_cancelled_history_is_store_responsibility(candidate):
    assert duplicate(candidate, []) is None


def test_output_validation_checks_words_and_georgian(payload):
    article = Article.model_validate(payload["article"])
    with pytest.raises(ValueError):
        validate_article(article, "STANDARD", {"STANDARD": [100, 150]})
    article.body = "English only."
    with pytest.raises(ValueError):
        validate_article(article, "STANDARD", {})


def test_long_article_uses_one_text_message(candidate, payload):
    payload["article"]["body"] = "სატესტო ტექსტი " * 90
    payload["image"] = {"context": "საარქივო", "author": "Test", "license": "cc0"}
    draft = SimpleNamespace(payload=payload)
    _, photo = delivery_text(draft)
    assert photo is False


def test_retrieved_url_provenance():
    response = SimpleNamespace(
        model_dump=lambda: {
            "output": [
                {
                    "type": "web_search_call",
                    "action": {"sources": [{"url": "https://alpha.example/a"}]},
                }
            ]
        }
    )
    assert retrieved_urls(response) == {"https://alpha.example/a"}


async def test_full_pipeline_creates_only_pending_draft(
    settings, store, candidate, payload, monkeypatch
):
    response = SimpleNamespace(
        output_text="Offline research",
        model_dump=lambda: {
            "output": [{"action": {"sources": [{"url": x} for x in candidate.source_urls]}}]
        },
    )

    async def call(instruction, data, schema=None, search=False):
        if search:
            return response
        return {
            Discovery: Discovery(candidates=[candidate]),
            Verification: Verification.model_validate(payload["verification"]),
            Article: Article.model_validate(payload["article"]),
            FactCheck: FactCheck(
                passed=True, unsupported_claims=[], missing_attributions=[], notes=[]
            ),
        }[schema]

    llm = SimpleNamespace(call=call)

    def fetch(url, domains):
        return {
            k: v
            for k, v in next(x for x in payload["sources"] if x["url"] == url).items()
            if k != "id"
        }

    monkeypatch.setattr("political_agent.newsroom.fetch_article", fetch)
    draft = await Newsroom(settings, store, llm).generate("Offline political fixture", "STANDARD")
    assert draft.status == "pending" and draft.message_id is None
    assert len(draft.payload["sources"]) == 2
    assert (await store.stats())["usage"][0]["runs"] == 1


async def test_pipeline_rejects_urls_not_returned_by_search(
    settings, store, candidate, monkeypatch
):
    research = SimpleNamespace(output_text="no URLs", model_dump=lambda: {"output": []})
    llm = AsyncMock()
    llm.call.side_effect = [research, Discovery(candidates=[candidate])]
    fetch = AsyncMock()
    monkeypatch.setattr("political_agent.newsroom.fetch_article", fetch)
    with pytest.raises(ValueError):
        await Newsroom(settings, store, llm).generate("offline", "STANDARD")
    fetch.assert_not_called()


async def test_missing_config_makes_no_llm_call(settings, store):
    settings.openai_api_key = ""
    # Rebuild validated settings rather than mutating a secret field to the wrong type.
    from pydantic import SecretStr

    settings.openai_api_key = SecretStr("")
    llm = AsyncMock()
    with pytest.raises(ValueError):
        await Newsroom(settings, store, llm).generate("offline", "STANDARD")
    llm.call.assert_not_awaited()


async def test_llm_reserves_budget_and_disables_hidden_retry(settings, store):
    model = LLM(settings, store)
    client = AsyncMock()
    client.responses.parse.return_value = SimpleNamespace(
        status="completed",
        output=[],
        usage=SimpleNamespace(input_tokens=20, output_tokens=10),
        output_parsed=FactCheck(
            passed=True, unsupported_claims=[], missing_attributions=[], notes=[]
        ),
    )
    model._client = client
    result = await model.call("offline", {}, FactCheck)
    assert result.passed
    stats = await store.stats()
    assert stats["usage"][0]["calls"] == 1
    assert stats["usage"][0]["input_tokens"] == 20
    assert client.responses.parse.call_args.kwargs["store"] is False


async def test_claim_source_omission_rejected(settings, store, payload):
    llm = AsyncMock()
    article = Article.model_validate(deepcopy(payload["article"]))
    article.source_ids = [0]
    with pytest.raises(ValueError):
        await Newsroom(settings, store, llm).validate_draft(
            article,
            Verification.model_validate(payload["verification"]),
            payload["sources"],
            "STANDARD",
        )
    llm.call.assert_not_awaited()
