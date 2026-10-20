"""Groq chat completions with model failover, on the server.

The browser sends the conversation and a tier ("quality" or "fast"); the server picks the
model, adds the key and forwards. If a model is retired (404), out of quota (429), too busy
(5xx) or the request is too large for it (413), the next model in the tier takes over. If a
model rejects an optional parameter (some do not support penalties or JSON mode), the
parameter is dropped and the same model is tried again; the same happens when strict JSON
mode rejects a reply (the app extracts JSON from plain text itself).
"""
from __future__ import annotations

import logging
import re

import httpx

log = logging.getLogger("mosel.llm")

OPTIONAL_PARAMS = ("presence_penalty", "frequency_penalty", "response_format", "top_p", "reasoning_format",
                   "reasoning_effort")
# gpt-oss thinks before it answers, and the thinking counts against max_tokens; give it room.
REASONING_HEADROOM = 1024
NEXT_MODEL_STATUSES = {404, 408, 413, 429, 500, 502, 503, 504}
# 400s that are the model's fault, not the request's: another model may well succeed.
NEXT_MODEL_ERRORS = ("tool_use_failed", "json_validate_failed", "output_parse_failed")  # after retries
# A German tutor must not answer in Chinese, Japanese or Korean script; Qwen occasionally slips into it.
FOREIGN_SCRIPT = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")


def _content(data: dict) -> str:
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        return ""


class LLMError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class GroqClient:
    def __init__(self, api_key: str, base_url: str, models: dict[str, list[str]],
                 transport: httpx.AsyncBaseTransport | None = None, timeout: float = 60.0):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.models = models
        self._client = httpx.AsyncClient(timeout=timeout, transport=transport)

    async def aclose(self):
        await self._client.aclose()

    @staticmethod
    def _model_defaults(model: str) -> dict:
        if model.startswith("qwen/"):
            return {"reasoning_format": "hidden"}     # Qwen 3 can think out loud; the app wants only the answer
        if "gpt-oss" in model:
            return {"reasoning_effort": "low"}        # short thinking leaves the token budget for the answer
        return {}

    @staticmethod
    def _model_params(model: str, params: dict) -> dict:
        params = dict(params)
        if "gpt-oss" in model and "max_tokens" in params:
            params["max_tokens"] = params["max_tokens"] + REASONING_HEADROOM
        return params

    async def chat(self, tier: str, messages: list[dict], params: dict) -> dict:
        models = self.models.get(tier) or self.models["quality"]
        last_error = "no model available"
        fallback = None                     # a reply in the wrong script, used only if nothing better comes
        for model in models:
            body = {"model": model, "messages": messages, **self._model_defaults(model),
                    **self._model_params(model, params)}
            for _ in range(len(OPTIONAL_PARAMS) + 1):
                r = await self._client.post(f"{self.base_url}/chat/completions", json=body,
                                            headers={"Authorization": f"Bearer {self.api_key}"})
                if r.status_code == 200:
                    data = r.json()
                    data.setdefault("model", model)
                    if not _content(data).strip():
                        log.warning("%s returned an empty answer (finish: %s); trying the next model", model,
                                    (data.get("choices") or [{}])[0].get("finish_reason"))
                        break
                    if FOREIGN_SCRIPT.search(_content(data)):
                        log.warning("%s answered with non-Latin script; trying the next model", model)
                        fallback = fallback or data
                        break
                    return data
                text = r.text[:400]
                dropped = next((p for p in OPTIONAL_PARAMS if p in body and p in text), None)
                if "json_validate_failed" in text and "response_format" in body:
                    # Strict JSON mode rejected the reply; the app parses JSON out of plain text itself.
                    dropped = "response_format"
                if r.status_code == 400 and dropped:
                    log.info("%s rejected %s; retrying without it", model, dropped)
                    body.pop(dropped)
                    continue
                break
            if r.status_code == 200:
                continue
            last_error = f"{model}: HTTP {r.status_code}: {text}"
            if r.status_code in NEXT_MODEL_STATUSES or any(code in text for code in NEXT_MODEL_ERRORS):
                log.warning("model %s unavailable (HTTP %s: %s); trying the next one", model, r.status_code, text[:160])
                continue
            if r.status_code in (401, 403):
                raise LLMError("the server's Groq key was rejected; check GROQ_API_KEY", 502)
            raise LLMError(f"the model rejected the request: {text}", 400)
        if fallback is not None:
            return fallback
        raise LLMError(f"every model is unavailable right now ({last_error[:200]})", 503)
