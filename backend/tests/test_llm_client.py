"""OpenAI-compatible LLM client (Groq / Gemini) against httpx.MockTransport."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from services.llm.openai_compat import LLMError, OpenAICompatLLM, extract_json


def make(handler, **kw) -> OpenAICompatLLM:
    return OpenAICompatLLM(
        provider="groq",
        base_url="https://api.example.test/v1",
        api_key="k",
        model="m",
        transport=httpx.MockTransport(handler),
        **kw,
    )


def ok(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


def test_complete_sends_bearer_model_and_json_mode():
    seen = {}

    def handler(request: httpx.Request):
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        seen["url"] = str(request.url)
        return ok('{"a": 1}')

    llm = make(handler, extra={"include_reasoning": False})
    out = asyncio.run(llm.complete([{"role": "user", "content": "hi"}], json_mode=True))
    assert out == '{"a": 1}'
    assert seen["auth"] == "Bearer k"
    assert seen["url"].endswith("/chat/completions")
    assert seen["body"]["model"] == "m"
    assert seen["body"]["response_format"] == {"type": "json_object"}
    assert seen["body"]["include_reasoning"] is False


def test_complete_retries_on_429_then_succeeds(monkeypatch):
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"retry-after": "0"}, json={"error": {"message": "slow down"}})
        return ok("done")

    assert asyncio.run(make(handler).complete([{"role": "user", "content": "x"}])) == "done"
    assert calls["n"] == 2


def test_complete_raises_on_401_without_retry():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(401, json={"error": {"message": "Invalid API Key"}})

    with pytest.raises(LLMError) as err:
        asyncio.run(make(handler).complete([{"role": "user", "content": "x"}]))
    assert "Invalid API Key" in str(err.value) and err.value.status == 401
    assert calls["n"] == 1


def test_json_mode_is_dropped_when_endpoint_rejects_it():
    bodies = []

    def handler(request):
        body = json.loads(request.content)
        bodies.append(body)
        if "response_format" in body:
            return httpx.Response(400, json=[{"error": {"message": "Unknown name response_format"}}])
        return ok('{"ok": true}')

    llm = make(handler)
    assert asyncio.run(llm.complete([{"role": "user", "content": "x"}], json_mode=True)) == '{"ok": true}'
    assert "response_format" in bodies[0] and "response_format" not in bodies[1]
    # Remembered for later calls.
    asyncio.run(llm.complete([{"role": "user", "content": "y"}], json_mode=True))
    assert "response_format" not in bodies[2]


def test_stream_yields_deltas_and_ignores_reasoning():
    sse = (
        'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request):
        assert json.loads(request.content)["stream"] is True
        return httpx.Response(200, content=sse.encode(), headers={"content-type": "text/event-stream"})

    async def collect():
        return [d async for d in make(handler).stream([{"role": "user", "content": "x"}])]

    assert asyncio.run(collect()) == ["Hel", "lo"]


def test_list_models_strips_prefix():
    def handler(request):
        return httpx.Response(200, json={"data": [{"id": "models/gemini-x"}, {"id": "openai/gpt-oss-20b"}]})

    assert asyncio.run(make(handler).list_models()) == ["gemini-x", "openai/gpt-oss-20b"]


def test_missing_key_raises():
    with pytest.raises(LLMError):
        OpenAICompatLLM(provider="gemini", base_url="x", api_key="", model="m")


@pytest.mark.parametrize(
    "raw,expected",
    [
        ('{"a": 1}', {"a": 1}),
        ('```json\n{"a": 2}\n```', {"a": 2}),
        ('Sure! Here it is: {"a": 3} hope that helps', {"a": 3}),
    ],
)
def test_extract_json(raw, expected):
    assert extract_json(raw) == expected


def test_registry_builds_groq_with_gpt_oss_extras(monkeypatch):
    from services.providers import registry

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.delenv("GROQ_FAST_MODEL", raising=False)
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    monkeypatch.setenv("GROQ_API_KEY", "g")
    llm = registry.build_llm(fast=True)
    try:
        assert llm.provider == "groq"
        assert llm.model == "openai/gpt-oss-20b"
        assert llm.extra == {"include_reasoning": False, "reasoning_effort": "low"}
        assert llm.base_url == "https://api.groq.com/openai/v1"
    finally:
        asyncio.run(llm.aclose())
