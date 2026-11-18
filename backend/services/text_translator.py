"""Text translation for STT providers without native translation (e.g. Deepgram)."""

from __future__ import annotations

import logging
import os
import uuid
from typing import Protocol

import httpx

from services.minimax_client import get_language_name

logger = logging.getLogger("interpreter.text_translator")


def is_auto(code: str | None) -> bool:
    """True when the source language is unknown (detected per segment, or not at all)."""
    return (code or "").split("-")[0].strip().lower() in {"", "auto", "multi"}


class TextTranslator(Protocol):
    name: str

    async def translate(self, text: str, source_lang: str, target_lang: str) -> str: ...

    async def close(self) -> None: ...


class LLMTranslator:
    name = "llm"

    def __init__(self) -> None:
        from services.providers import registry

        requested = os.getenv("LLM_TRANSLATION_PROVIDER", "").strip().lower() or None
        if requested is None and registry.is_configured("llm", "groq"):
            requested = "groq"  # lowest latency for short live segments
        self._llm = registry.build_llm(requested, fast=True)
        self.provider = self._llm.provider

    async def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        if not text.strip():
            return ""
        tgt = get_language_name(target_lang)
        if is_auto(source_lang):
            task = (
                f"You are a live meeting interpreter. The user's speech may be in any language. Translate it "
                f"into natural, spoken {tgt}. If it is already in {tgt}, return it unchanged. "
            )
        else:
            task = (
                f"You are a live meeting interpreter. Translate the user's {get_language_name(source_lang)} "
                f"speech into natural, spoken {tgt}. "
            )
        out = await self._llm.complete(
            [
                {
                    "role": "system",
                    "content": task + (
                        "Output only the translation — no quotes, notes, or explanations. "
                        "Keep names, numbers and product terms unchanged."
                    ),
                },
                {"role": "user", "content": text},
            ],
            temperature=0.1,
            max_tokens=400,
        )
        return out.strip().strip('"').strip()

    async def close(self) -> None:
        await self._llm.aclose()


class AzureTextTranslator:
    """Azure Translator v3 (global endpoint). Needs a Translator or multi-service key."""

    name = "azure_translator"
    ENDPOINT = "https://api.cognitive.microsofttranslator.com/translate"

    def __init__(self) -> None:
        self.key = os.getenv("AZURE_TRANSLATOR_KEY", "").strip() or os.getenv("AZURE_SPEECH_KEY", "").strip()
        self.region = (
            os.getenv("AZURE_TRANSLATOR_REGION", "").strip() or os.getenv("AZURE_SPEECH_REGION", "").strip()
        )
        self._client = httpx.AsyncClient(timeout=10.0)

    async def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        if not text.strip():
            return ""
        target = "zh-Hans" if target_lang.startswith("zh") else target_lang.split("-")[0]
        headers = {
            "Ocp-Apim-Subscription-Key": self.key,
            "Content-Type": "application/json",
            "X-ClientTraceId": str(uuid.uuid4()),
        }
        if self.region:
            headers["Ocp-Apim-Subscription-Region"] = self.region
        params = {"api-version": "3.0", "to": target}
        if not is_auto(source_lang):
            params["from"] = source_lang.split("-")[0]  # omitted → Azure detects the language
        resp = await self._client.post(self.ENDPOINT, params=params, headers=headers, json=[{"text": text}])
        resp.raise_for_status()
        data = resp.json()
        try:
            detected = (data[0].get("detectedLanguage") or {}).get("language")
            if detected and detected.split("-")[0].lower() == target_lang.split("-")[0].lower():
                return text  # already in the target language
            return data[0]["translations"][0]["text"]
        except (KeyError, IndexError, TypeError, AttributeError):
            return ""

    async def close(self) -> None:
        await self._client.aclose()


class MinimaxTranslator:
    name = "minimax"

    def __init__(self) -> None:
        from services.minimax_client import MinimaxClient

        self._client = MinimaxClient(
            api_key=os.getenv("MINIMAX_API_KEY", ""), group_id=os.getenv("MINIMAX_GROUP_ID", "")
        )

    async def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        out = await self._client.translate(
            text=text,
            source_language=get_language_name(source_lang),
            target_language=get_language_name(target_lang),
        )
        return (out or "").strip()

    async def close(self) -> None:
        await self._client.close()


def build(provider_id: str) -> TextTranslator:
    if provider_id == "llm":
        return LLMTranslator()
    if provider_id == "azure_translator":
        return AzureTextTranslator()
    if provider_id == "minimax":
        return MinimaxTranslator()
    raise ValueError(f"Unknown translator '{provider_id}'")
