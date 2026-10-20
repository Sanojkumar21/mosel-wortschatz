"""The web server: serves the trainer, the word list and an AI endpoint that keeps the key server-side."""
from __future__ import annotations

import hmac
import logging
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from mosel import __version__
from mosel.config import Settings, load_settings
from mosel.llm import GroqClient, LLMError
from mosel.ratelimit import RateLimiter
from mosel.vocab import load_dataset

log = logging.getLogger("mosel")

MAX_MESSAGE_CHARS = 12_000
MAX_TOTAL_CHARS = 40_000


class Message(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str = Field(max_length=MAX_MESSAGE_CHARS)


class ChatRequest(BaseModel):
    tier: Literal["quality", "fast"] = "quality"
    messages: list[Message] = Field(min_length=1, max_length=40)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1)
    top_p: float | None = Field(default=None, gt=0, le=1)
    presence_penalty: float | None = Field(default=None, ge=-2, le=2)
    frequency_penalty: float | None = Field(default=None, ge=-2, le=2)
    response_format: dict | None = None

    @field_validator("messages")
    @classmethod
    def total_size(cls, messages):
        if sum(len(m.content) for m in messages) > MAX_TOTAL_CHARS:
            raise ValueError(f"the conversation is longer than {MAX_TOTAL_CHARS} characters")
        return messages

    @field_validator("response_format")
    @classmethod
    def json_mode_only(cls, value):
        if value is not None and value != {"type": "json_object"}:
            raise ValueError('response_format may only be {"type": "json_object"}')
        return value


def client_id(request: Request, settings: Settings) -> str:
    if settings.trust_proxy:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def create_app(settings: Settings | None = None, transport=None) -> FastAPI:
    settings = settings or load_settings()
    dataset = load_dataset(settings.data_dir)
    limiter = RateLimiter(settings.rate_per_minute, settings.rate_per_day, settings.daily_cap)
    groq = GroqClient(settings.groq_api_key, settings.groq_base_url,
                      {"quality": settings.models_quality, "fast": settings.models_fast}, transport=transport)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        log.info("serving %s word list: %d chapters, %d words; AI %s", dataset["source"], dataset["chapter_count"],
                 dataset["word_count"], "on" if settings.ai_enabled else "off (set GROQ_API_KEY)")
        yield
        await groq.aclose()

    app = FastAPI(title="Mosel Wortschatz", version=__version__, lifespan=lifespan,
                  docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)

    @app.get("/api/health")
    def health():
        return {"ok": True, "version": __version__, "ai": settings.ai_enabled,
                "access_code_required": bool(settings.access_code),
                "dataset": dataset["source"], "chapters": dataset["chapter_count"], "words": dataset["word_count"]}

    @app.get("/api/vocab")
    def vocab():
        return JSONResponse(
            {"source": dataset["source"], "chapters": dataset["chapters"], "examples_en": dataset["examples_en"]},
            headers={"Cache-Control": "public, max-age=300"})

    @app.post("/api/ai/chat")
    async def ai_chat(req: ChatRequest, request: Request):
        if not settings.ai_enabled:
            raise HTTPException(503, "AI is not configured on this server (GROQ_API_KEY is not set)")
        if settings.access_code:
            sent = request.headers.get("x-access-code", "")
            if not hmac.compare_digest(sent.encode(), settings.access_code.encode()):
                raise HTTPException(401, "access code required")
        reason = limiter.check(client_id(request, settings))
        if reason:
            raise HTTPException(429, reason)
        params = req.model_dump(exclude_none=True, exclude={"tier", "messages"})
        if "max_tokens" in params:
            params["max_tokens"] = min(params["max_tokens"], settings.max_tokens_cap)
        try:
            return await groq.chat(req.tier, [m.model_dump() for m in req.messages], params)
        except LLMError as e:
            raise HTTPException(e.status, str(e)) from None

    # The trainer itself: index.html, css, js. Mounted last so /api/* wins.
    app.mount("/", StaticFiles(directory=settings.web_dir, html=True), name="web")
    return app
