"""Minimal async client for OpenAI-compatible chat-completions APIs.

One class covers Groq (api.groq.com/openai/v1) and Gemini's OpenAI-compatible
endpoint (generativelanguage.googleapis.com/v1beta/openai). Uses httpx only so
we don't pull in vendor SDKs.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
from typing import Any, AsyncIterator

import httpx

logger = logging.getLogger("interpreter.llm")

RETRY_STATUSES = {408, 409, 425, 429, 500, 502, 503, 504}


class LLMError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, provider: str | None = None):
        super().__init__(message)
        self.status = status
        self.provider = provider


class OpenAICompatLLM:
    def __init__(
        self,
        *,
        provider: str,
        base_url: str,
        api_key: str,
        model: str,
        timeout: float = 90.0,
        max_retries: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        if not api_key:
            raise LLMError(f"{provider} API key is not configured", provider=provider)
        self.provider = provider
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.max_retries = max_retries
        self.extra = dict(extra or {})
        # Flipped off if the endpoint rejects them (e.g. Gemini's OpenAI layer
        # does not document response_format=json_object).
        self._json_mode_supported = True
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=10.0),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "OpenAICompatLLM":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    def _payload(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int | None,
        json_mode: bool,
        stream: bool,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "stream": stream,
        }
        if max_tokens:
            payload["max_tokens"] = max_tokens
        if json_mode and self._json_mode_supported:
            payload["response_format"] = {"type": "json_object"}
        payload.update(self.extra)
        return payload

    def _degrade(self, payload: dict[str, Any], error: "LLMError") -> bool:
        """On a 400 caused by an optional parameter, drop it and retry once."""
        if error.status != 400:
            return False
        message = str(error).lower()
        changed = False
        if "response_format" in payload and ("response_format" in message or "json" in message):
            payload.pop("response_format")
            self._json_mode_supported = False
            changed = True
        for key in list(self.extra):
            if key in payload and key.lower() in message:
                payload.pop(key)
                self.extra.pop(key, None)
                changed = True
        if not changed and (payload.keys() & ({"response_format"} | set(self.extra))):
            # Unknown 400: strip every optional knob once.
            payload.pop("response_format", None)
            for key in list(self.extra):
                payload.pop(key, None)
            changed = True
        if changed:
            logger.warning("%s rejected optional parameters; retrying without them (%s)", self.provider, error)
        return changed

    @staticmethod
    def _retry_delay(attempt: int, response: httpx.Response | None) -> float:
        if response is not None:
            retry_after = response.headers.get("retry-after")
            if retry_after:
                try:
                    return min(float(retry_after), 20.0)
                except ValueError:
                    pass
        return min(2 ** attempt, 8) * 0.5 + random.uniform(0, 0.25)

    def _error_from(self, response: httpx.Response) -> LLMError:
        detail = response.text[:500]
        try:
            body = response.json()
            if isinstance(body, list) and body:
                body = body[0]
            err = body.get("error") if isinstance(body, dict) else None
            if isinstance(err, dict) and err.get("message"):
                detail = err["message"]
        except ValueError:
            pass
        return LLMError(
            f"{self.provider} request failed ({response.status_code}): {detail}",
            status=response.status_code,
            provider=self.provider,
        )

    async def complete(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.2,
        max_tokens: int | None = None,
        json_mode: bool = False,
    ) -> str:
        payload = self._payload(
            messages, temperature=temperature, max_tokens=max_tokens, json_mode=json_mode, stream=False
        )
        last_error: Exception | None = None
        degraded = False
        for attempt in range(self.max_retries + 1):
            response: httpx.Response | None = None
            try:
                response = await self._client.post(f"{self.base_url}/chat/completions", json=payload)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_error = LLMError(f"{self.provider} network error: {exc}", provider=self.provider)
            else:
                if response.status_code == 200:
                    data = response.json()
                    try:
                        content = data["choices"][0]["message"].get("content") or ""
                    except (KeyError, IndexError, TypeError) as exc:
                        raise LLMError(f"{self.provider} returned an unexpected response", provider=self.provider) from exc
                    return content
                last_error = self._error_from(response)
                if not degraded and self._degrade(payload, last_error):
                    degraded = True
                    continue
                if response.status_code not in RETRY_STATUSES:
                    raise last_error
            if attempt < self.max_retries:
                await asyncio.sleep(self._retry_delay(attempt, response))
        assert last_error is not None
        raise last_error

    async def stream(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.3,
        max_tokens: int | None = None,
    ) -> AsyncIterator[str]:
        """Yield text deltas. Retries only before the first token arrives."""
        payload = self._payload(
            messages, temperature=temperature, max_tokens=max_tokens, json_mode=False, stream=True
        )
        degraded = False
        for attempt in range(self.max_retries + 1):
            yielded = False
            try:
                async with self._client.stream(
                    "POST", f"{self.base_url}/chat/completions", json=payload
                ) as response:
                    if response.status_code != 200:
                        await response.aread()
                        error = self._error_from(response)
                        if not degraded and self._degrade(payload, error):
                            degraded = True
                            continue
                        if response.status_code in RETRY_STATUSES and attempt < self.max_retries:
                            await asyncio.sleep(self._retry_delay(attempt, response))
                            continue
                        raise error
                    async for line in response.aiter_lines():
                        line = line.strip()
                        if not line or not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            return
                        try:
                            chunk = json.loads(data)
                        except ValueError:
                            continue
                        if isinstance(chunk, dict) and chunk.get("error"):
                            raise LLMError(
                                f"{self.provider} stream error: {chunk['error']}", provider=self.provider
                            )
                        for choice in chunk.get("choices") or []:
                            delta = (choice.get("delta") or {}).get("content")
                            if delta:
                                yielded = True
                                yield delta
                    return
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                if yielded or attempt >= self.max_retries:
                    raise LLMError(f"{self.provider} network error: {exc}", provider=self.provider) from exc
                await asyncio.sleep(self._retry_delay(attempt, None))

    async def list_models(self) -> list[str]:
        response = await self._client.get(f"{self.base_url}/models")
        if response.status_code != 200:
            raise self._error_from(response)
        data = response.json()
        items = data.get("data") if isinstance(data, dict) else data
        ids = []
        for item in items or []:
            if isinstance(item, dict) and item.get("id"):
                ids.append(str(item["id"]).removeprefix("models/"))
        return ids


_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def extract_json(text: str) -> Any:
    """Parse JSON from an LLM reply, tolerating code fences and stray prose."""
    cleaned = _FENCE_RE.sub("", (text or "").strip())
    try:
        return json.loads(cleaned)
    except ValueError:
        pass
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end > start:
        return json.loads(cleaned[start : end + 1])
    raise ValueError("No JSON object found in model output")
