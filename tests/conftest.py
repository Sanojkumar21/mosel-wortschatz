import json
import shutil
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from mosel.config import Settings
from mosel.main import create_app

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def data_dir(tmp_path):
    """A data folder with only the public sample list (no private data in tests)."""
    shutil.copytree(ROOT / "data" / "sample", tmp_path / "sample")
    return tmp_path


class FakeGroq:
    """Stands in for api.groq.com. `script` maps model -> list of (status, body) replies."""

    def __init__(self, script=None):
        self.script = script or {}
        self.calls = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.calls.append({"body": body, "auth": request.headers.get("authorization")})
        replies = self.script.get(body["model"]) or [(200, None)]
        status, payload = replies.pop(0) if len(replies) > 1 else replies[0]
        if status == 200 and payload is None:
            payload = {"choices": [{"message": {"role": "assistant", "content": '{"ok": true}'}}],
                       "usage": {"total_tokens": 10}}
        return httpx.Response(status, json=payload if isinstance(payload, dict) else {"error": {"message": payload}})


@pytest.fixture
def make_client(data_dir):
    def build(script=None, **overrides):
        fake = FakeGroq(script)
        settings = Settings(groq_api_key="test-key", data_dir=data_dir, **overrides)
        client = TestClient(create_app(settings, transport=httpx.MockTransport(fake.handler)))
        return client, fake
    return build


def chat_body(**extra):
    return {"tier": "quality", "messages": [{"role": "user", "content": "Hallo"}], **extra}
