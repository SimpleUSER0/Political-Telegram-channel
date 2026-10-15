from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Candidate(StrictModel):
    event_key: str
    topic: str
    category: str
    event_at: datetime
    importance: int = Field(ge=0, le=100)
    selection_reason: str
    source_urls: list[str]
    image_query: str


class Discovery(StrictModel):
    candidates: list[Candidate]


class Evidence(StrictModel):
    source_id: int
    excerpt: str


class Claim(StrictModel):
    text: str
    status: Literal["verified", "attributed", "unverified", "disputed"]
    attribution: str
    origin_groups: list[str]
    evidence: list[Evidence]


class SourceAssessment(StrictModel):
    source_id: int
    published_at: datetime | None
    publisher: str
    origin_group: str
    kind: Literal["primary", "independent", "syndicated", "unknown"]
    reliability_note: str


class Verification(StrictModel):
    sources: list[SourceAssessment]
    claims: list[Claim]
    contradictions: list[str]
    publishable: bool
    reason: str


class Article(StrictModel):
    title: str
    body: str
    claim_ids: list[int]
    source_ids: list[int]


class FactCheck(StrictModel):
    passed: bool
    unsupported_claims: list[str]
    missing_attributions: list[str]
    notes: list[str]


class GenerateRequest(StrictModel):
    query: str = Field(min_length=3, max_length=1000)
    post_format: Literal["FLASH", "QUICK", "STANDARD", "DEEP"] = "STANDARD"


class EditRequest(StrictModel):
    version: int = Field(ge=1)
    title: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=12000)
