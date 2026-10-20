from conftest import chat_body

from mosel.config import Settings
from mosel.main import create_app


def test_health_reports_dataset_and_ai(make_client):
    client, _ = make_client()
    h = client.get("/api/health").json()
    assert h["ok"] and h["ai"] is True and h["dataset"] == "sample" and h["words"] == 60


def test_vocab_serves_the_word_list(make_client):
    client, _ = make_client()
    v = client.get("/api/vocab").json()
    assert v["source"] == "sample" and len(v["chapters"]) == 3 and v["examples_en"]["1"]


def test_frontend_is_served(make_client):
    client, _ = make_client()
    r = client.get("/")
    assert r.status_code == 200 and "Mosel" in r.text and "js/api.js" in r.text
    assert client.get("/js/app.js").status_code == 200


def test_chat_forwards_with_the_server_key_and_returns_groq_json(make_client):
    client, fake = make_client()
    r = client.post("/api/ai/chat", json=chat_body(temperature=0.4, max_tokens=300))
    assert r.status_code == 200 and r.json()["choices"][0]["message"]["content"] == '{"ok": true}'
    sent = fake.calls[0]
    assert sent["auth"] == "Bearer test-key"
    assert sent["body"]["model"] == "openai/gpt-oss-120b" and sent["body"]["temperature"] == 0.4
    assert "tier" not in sent["body"]


def test_the_key_never_reaches_the_browser(make_client):
    client, _ = make_client()
    for path in ("/api/health", "/api/vocab", "/", "/js/api.js"):
        assert "test-key" not in client.get(path).text


def test_ai_off_without_a_key(data_dir):
    from fastapi.testclient import TestClient
    client = TestClient(create_app(Settings(groq_api_key="", data_dir=data_dir)))
    assert client.get("/api/health").json()["ai"] is False
    assert client.post("/api/ai/chat", json=chat_body()).status_code == 503


def test_access_code(make_client):
    client, _ = make_client(access_code="mosel123")
    assert client.post("/api/ai/chat", json=chat_body()).status_code == 401
    assert client.post("/api/ai/chat", json=chat_body(), headers={"X-Access-Code": "wrong"}).status_code == 401
    assert client.post("/api/ai/chat", json=chat_body(), headers={"X-Access-Code": "mosel123"}).status_code == 200


def test_rate_limit_per_client(make_client):
    client, _ = make_client(rate_per_minute=2)
    codes = [client.post("/api/ai/chat", json=chat_body()).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


def test_max_tokens_is_capped(make_client):
    client, fake = make_client(max_tokens_cap=500)
    client.post("/api/ai/chat", json=chat_body(max_tokens=5000))
    assert fake.calls[0]["body"]["max_tokens"] == 500 + 1024      # the answer is capped; gpt-oss gets thinking room


def test_request_validation(make_client):
    client, _ = make_client()
    assert client.post("/api/ai/chat", json={"messages": []}).status_code == 422
    assert client.post("/api/ai/chat", json=chat_body(response_format={"type": "text"})).status_code == 422
    huge = {"tier": "fast", "messages": [{"role": "user", "content": "x" * 11_000}] * 4}
    assert client.post("/api/ai/chat", json=huge).status_code == 422
    assert client.post("/api/ai/chat", json={"messages": [{"role": "tool", "content": "x"}]}).status_code == 422
