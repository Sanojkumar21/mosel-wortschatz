"""Settings, read from the environment (and a local .env file, if present).

Secrets live only here, on the server. The browser never sees the Groq key.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path) -> None:
    """Minimal .env reader: KEY=VALUE lines; existing environment variables win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.split(" #", 1)[0].strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


def _models(name: str, default: str) -> list[str]:
    return [m.strip() for m in os.environ.get(name, default).split(",") if m.strip()]


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class Settings:
    groq_api_key: str = ""
    groq_base_url: str = "https://api.groq.com/openai/v1"
    # Tried in order: a model that is unavailable, out of quota or overloaded hands over to the next.
    # Qwen is last: at high temperature it sometimes slips Chinese characters into German text.
    models_quality: list[str] = field(
        default_factory=lambda: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"])
    models_fast: list[str] = field(
        default_factory=lambda: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"])
    access_code: str = ""              # if set, AI requests must send it (keeps strangers off your quota)
    rate_per_minute: int = 12          # AI requests per client per minute
    rate_per_day: int = 300            # AI requests per client per day
    daily_cap: int = 1500              # AI requests per day for the whole server
    max_tokens_cap: int = 2500
    trust_proxy: bool = False          # read the client IP from X-Forwarded-For (behind Render, Fly, nginx)
    data_dir: Path = ROOT / "data"
    wordlist_dir: Path | None = None   # a folder with your own vocab.json, e.g. outside the repository
    web_dir: Path = ROOT / "web"

    @property
    def ai_enabled(self) -> bool:
        return bool(self.groq_api_key)


def load_settings(env_file: Path | None = None) -> Settings:
    load_dotenv(env_file or ROOT / ".env")
    defaults = Settings()
    return Settings(
        groq_api_key=os.environ.get("GROQ_API_KEY", "").strip(),
        groq_base_url=os.environ.get("GROQ_BASE_URL", defaults.groq_base_url).rstrip("/"),
        models_quality=_models("GROQ_MODELS_QUALITY", ",".join(defaults.models_quality)),
        models_fast=_models("GROQ_MODELS_FAST", ",".join(defaults.models_fast)),
        access_code=os.environ.get("ACCESS_CODE", "").strip(),
        rate_per_minute=_int("RATE_PER_MINUTE", defaults.rate_per_minute),
        rate_per_day=_int("RATE_PER_DAY", defaults.rate_per_day),
        daily_cap=_int("DAILY_CAP", defaults.daily_cap),
        max_tokens_cap=_int("MAX_TOKENS_CAP", defaults.max_tokens_cap),
        trust_proxy=os.environ.get("TRUST_PROXY", "").lower() in ("1", "true", "yes"),
        data_dir=Path(os.environ.get("DATA_DIR", defaults.data_dir)),
        wordlist_dir=Path(os.environ["WORDLIST_DIR"]) if os.environ.get("WORDLIST_DIR") else None,
        web_dir=Path(os.environ.get("WEB_DIR", defaults.web_dir)),
    )
