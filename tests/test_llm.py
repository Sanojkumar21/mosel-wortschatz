from conftest import chat_body

Q1, Q2, Q3 = "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"


def reply(text):
    return {"choices": [{"message": {"role": "assistant", "content": text}}]}


def test_retired_model_hands_over_to_the_next(make_client):
    client, fake = make_client({Q1: [(404, "model_not_found")]})
    r = client.post("/api/ai/chat", json=chat_body())
    assert r.status_code == 200 and r.json()["model"] == Q2
    assert [c["body"]["model"] for c in fake.calls] == [Q1, Q2]


def test_quota_exhausted_hands_over(make_client):
    client, _ = make_client({Q1: [(429, "rate limit")], Q2: [(503, "busy")]})
    assert client.post("/api/ai/chat", json=chat_body()).json()["model"] == Q3


def test_unsupported_parameter_is_dropped_and_retried(make_client):
    client, fake = make_client({Q1: [(400, "presence_penalty is not supported"), (200, None)]})
    r = client.post("/api/ai/chat", json=chat_body(presence_penalty=0.3, frequency_penalty=0.4))
    assert r.status_code == 200
    assert "presence_penalty" in fake.calls[0]["body"] and "presence_penalty" not in fake.calls[1]["body"]
    assert fake.calls[1]["body"]["frequency_penalty"] == 0.4


def test_model_side_400_tries_another_model(make_client):
    client, _ = make_client({Q1: [(400, "tool_use_failed: model called a tool")]})
    assert client.post("/api/ai/chat", json=chat_body()).json()["model"] == Q2


def test_reply_in_chinese_script_is_replaced_by_the_next_model(make_client):
    client, _ = make_client({Q1: [(200, reply("Am Sonntag想去 wir wandern."))],
                             Q2: [(200, reply("Am Sonntag wollen wir wandern."))]})
    r = client.post("/api/ai/chat", json=chat_body())
    assert r.json()["model"] == Q2 and "想" not in r.text


def test_wrong_script_reply_is_still_better_than_nothing(make_client):
    client, _ = make_client({Q1: [(200, reply("Wir想 wandern."))], Q2: [(503, "busy")], Q3: [(503, "busy")]})
    r = client.post("/api/ai/chat", json=chat_body())
    assert r.status_code == 200 and r.json()["model"] == Q1


def test_qwen_hides_its_reasoning(make_client):
    client, fake = make_client(models_quality=[Q3])
    client.post("/api/ai/chat", json=chat_body())
    assert fake.calls[0]["body"]["reasoning_format"] == "hidden"
    client, fake = make_client()
    client.post("/api/ai/chat", json=chat_body())
    assert "reasoning_format" not in fake.calls[0]["body"]


def test_fast_tier_uses_its_own_models(make_client):
    client, fake = make_client({Q2: [(429, "busy")]})
    client.post("/api/ai/chat", json=chat_body(tier="fast"))
    assert [c["body"]["model"] for c in fake.calls] == [Q2, Q1]


def test_all_models_down_is_a_clear_503(make_client):
    down = [(503, "busy")]
    client, _ = make_client({Q1: down, Q2: down, Q3: down})
    r = client.post("/api/ai/chat", json=chat_body())
    assert r.status_code == 503 and "unavailable" in r.json()["detail"]


def test_bad_server_key_is_reported_without_leaking_it(make_client):
    client, _ = make_client({Q1: [(401, "invalid api key")]})
    r = client.post("/api/ai/chat", json=chat_body())
    assert r.status_code == 502 and "GROQ_API_KEY" in r.json()["detail"] and "test-key" not in r.text


def test_strict_json_rejection_retries_the_same_model_without_json_mode(make_client):
    rejected = '{"error": {"message": "Failed to validate JSON", "code": "json_validate_failed"}}'
    client, fake = make_client({Q1: [(400, rejected), (200, None)]})
    r = client.post("/api/ai/chat", json=chat_body(response_format={"type": "json_object"}))
    assert r.status_code == 200 and r.json()["model"] == Q1
    assert "response_format" in fake.calls[0]["body"] and "response_format" not in fake.calls[1]["body"]


def test_gpt_oss_gets_light_reasoning_and_token_headroom(make_client):
    client, fake = make_client()
    client.post("/api/ai/chat", json=chat_body(max_tokens=1700))
    body = fake.calls[0]["body"]
    assert body["model"] == Q1 and body["reasoning_effort"] == "low" and body["max_tokens"] == 1700 + 1024


def test_empty_answer_tries_the_next_model(make_client):
    empty = {"choices": [{"message": {"role": "assistant", "content": ""}, "finish_reason": "length"}]}
    client, _ = make_client({Q1: [(200, empty)]})
    assert client.post("/api/ai/chat", json=chat_body()).json()["model"] == Q2
