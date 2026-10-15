import re
from zoneinfo import ZoneInfo

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)

    app_env: str = "development"
    database_url: SecretStr = SecretStr("sqlite+aiosqlite:///./political-agent.db")
    openai_api_key: SecretStr = SecretStr("")
    openai_model: str = ""  # Choose explicitly after checking account/model access.
    telegram_bot_token: SecretStr = SecretStr("")
    telegram_webhook_secret: SecretStr = SecretStr("")
    admin_api_token: SecretStr = SecretStr("")
    owner_chat_id: int = 0
    channel_id: str = ""
    expected_bot_username: str = ""
    public_base_url: str = ""
    publishing_enabled: bool = False
    worker_enabled: bool = False
    scheduler_enabled: bool = False
    schedule_times: str = ""  # HH:MM,HH:MM; no editorial schedule is assumed.
    timezone: str = "Asia/Tbilisi"
    source_domains: str = ""  # Explicit allowlist, comma separated.
    source_origin_groups: dict[str, str] = Field(default_factory=dict)
    format_word_limits: dict[str, list[int]] = Field(default_factory=dict)
    default_format: str = "STANDARD"
    max_daily_runs: int = Field(default=4, ge=1, le=100)
    max_daily_api_calls: int = Field(default=24, ge=1, le=1000)
    max_output_tokens: int = Field(default=4000, ge=512, le=12000)
    max_search_calls: int = Field(default=3, ge=1, le=5)
    max_source_age_hours: int = Field(default=48, ge=1, le=720)
    draft_ttl_minutes: int = Field(default=120, ge=1, le=1440)
    history_days: int = Field(default=7, ge=1, le=365)
    job_timeout_seconds: int = Field(default=600, ge=60, le=1800)
    commons_enabled: bool = True
    max_webhook_bytes: int = 262144

    @model_validator(mode="after")
    def validate_settings(self):
        ZoneInfo(self.timezone)
        if self.default_format not in {"FLASH", "QUICK", "STANDARD", "DEEP"}:
            raise ValueError("Invalid default format")
        for name, limits in self.format_word_limits.items():
            if name not in {"FLASH", "QUICK", "STANDARD", "DEEP"}:
                raise ValueError("Unknown post format")
            if len(limits) != 2 or not 1 <= limits[0] <= limits[1] <= 1500:
                raise ValueError("Invalid format word limits")
        for slot in self.slots:
            if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", slot):
                raise ValueError("Schedule must contain HH:MM values")
        if self.scheduler_enabled and (not self.worker_enabled or not self.slots):
            raise ValueError("Scheduler requires worker and explicit schedule")
        if self.app_env == "production":
            if not self.async_database_url.startswith("postgresql+asyncpg://"):
                raise ValueError("Production requires PostgreSQL")
            if len(self.admin_api_token.get_secret_value()) < 32:
                raise ValueError("Production requires an ADMIN_API_TOKEN of at least 32 characters")
        if self.telegram_bot_token.get_secret_value():
            secret = self.telegram_webhook_secret.get_secret_value()
            if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", secret):
                raise ValueError("Telegram requires a 32-128 character webhook secret")
            if self.owner_chat_id <= 0:
                raise ValueError("OWNER_CHAT_ID must identify a private owner chat")
        if self.publishing_enabled and (
            not self.telegram_bot_token.get_secret_value() or not self.channel_id
        ):
            raise ValueError("Publishing requires a bot and independent channel")
        if self.channel_id.lstrip("@").casefold() == "cifruli_era":
            raise ValueError("The existing technology channel must not be used")
        if (
            self.app_env == "production"
            and self.telegram_bot_token.get_secret_value()
            and not self.expected_bot_username
        ):
            raise ValueError("Production requires EXPECTED_BOT_USERNAME for isolation")
        return self

    @property
    def async_database_url(self):
        url = self.database_url.get_secret_value()
        for prefix in ("postgres://", "postgresql://"):
            if url.startswith(prefix):
                return "postgresql+asyncpg://" + url[len(prefix) :]
        return url

    @property
    def domains(self):
        return {
            x.strip().lower().removeprefix("www.")
            for x in self.source_domains.split(",")
            if x.strip()
        }

    @property
    def slots(self):
        return sorted({x.strip() for x in self.schedule_times.split(",") if x.strip()})

    def research_missing(self):
        return [
            name
            for name, ready in {
                "OPENAI_API_KEY": bool(self.openai_api_key.get_secret_value()),
                "OPENAI_MODEL": bool(self.openai_model),
                "SOURCE_DOMAINS": bool(self.domains),
            }.items()
            if not ready
        ]
