"""Provider registry: capability matrix, key detection, defaults and factories.

Every provider is selected by id. Defaults come from env (STT_PROVIDER,
TTS_PROVIDER, LLM_PROVIDER, TRANSLATION_PROVIDER); if the env default has no
key, the first configured provider in DEFAULT_ORDER is used instead. A
provider explicitly requested by the extension must be configured, otherwise
ProviderConfigError explains which key is missing.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger("interpreter.providers")

# Languages the extension offers (extension/src/utils/languages.ts).
ORIGINAL_16 = frozenset(
    {"en", "es", "fr", "de", "it", "pt", "zh", "ja", "ko", "ar", "hi", "ru", "nl", "sv", "pl", "tr"}
)
# Indian languages added for multilingual meetings (Soniox / Azure / Deepgram cover them).
INDIC_LANGUAGES = frozenset({"gu", "bn", "ta", "te", "mr", "ur", "pa", "kn", "ml"})
APP_LANGUAGES = ORIGINAL_16 | INDIC_LANGUAGES

# Source-language values meaning "detect whatever language is spoken".
AUTO_LANGUAGES = frozenset({"auto", "multi"})


def is_auto_language(code: str | None) -> bool:
    return (code or "").split("-")[0].strip().lower() in AUTO_LANGUAGES


class ProviderConfigError(ValueError):
    """A provider is missing, unknown, or lacks its API key."""


@dataclass(frozen=True)
class ProviderSpec:
    id: str
    label: str
    env_keys: tuple[str, ...]
    diarization: bool = False
    native_translation: bool = False
    languages: frozenset[str] | None = None  # None = every app language
    notes: str = ""
    auto_language: bool = False  # STT: can identify the spoken language itself

    def configured(self) -> bool:
        return all(os.getenv(k, "").strip() for k in self.env_keys)

    def supports(self, language: str | None) -> bool:
        if not language or self.languages is None:
            return True
        return language.split("-")[0].lower() in self.languages

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "configured": self.configured(),
            "env_keys": list(self.env_keys),
            "diarization": self.diarization,
            "native_translation": self.native_translation,
            "languages": sorted(self.languages) if self.languages is not None else None,
            "notes": self.notes,
            "auto_language": self.auto_language,
        }


STT_SPECS: dict[str, ProviderSpec] = {
    "soniox": ProviderSpec(
        "soniox", "Soniox", ("SONIOX_API_KEY",), diarization=True, native_translation=True,
        notes="Realtime STT + translation + diarization + language identification",
        auto_language=True,
    ),
    "deepgram": ProviderSpec(
        "deepgram", "Deepgram", ("DEEPGRAM_API_KEY",), diarization=True,
        notes="Realtime STT + diarization (+ multilingual detection); translation via text translator",
        auto_language=True,
    ),
    # The added Indian languages are unverified on these providers, so they keep the original set.
    "speechmatics": ProviderSpec(
        "speechmatics", "Speechmatics", ("SPEECHMATICS_API_KEY",), native_translation=True,
        languages=ORIGINAL_16, notes="Realtime STT + translation",
    ),
    "azure": ProviderSpec(
        "azure", "Azure Speech (translation)", ("AZURE_SPEECH_KEY",), native_translation=True,
        languages=ORIGINAL_16, notes="Azure TranslationRecognizer",
    ),
    "azure_diarize": ProviderSpec(
        "azure_diarize", "Azure Speech (diarization)", ("AZURE_SPEECH_KEY",), diarization=True,
        native_translation=True, languages=ORIGINAL_16, notes="ConversationTranscriber + Azure Translator",
    ),
}

TTS_SPECS: dict[str, ProviderSpec] = {
    "soniox": ProviderSpec("soniox", "Soniox TTS", ("SONIOX_API_KEY",)),
    "azure": ProviderSpec("azure", "Azure Neural TTS", ("AZURE_SPEECH_KEY",)),
    "deepgram": ProviderSpec(
        "deepgram", "Deepgram Flux TTS", ("DEEPGRAM_API_KEY",),
        # Flux TTS has no Arabic, Malayalam or Punjabi voice (developers.deepgram.com/docs/flux-tts/voices).
        languages=APP_LANGUAGES - {"ar", "ml", "pa"},
    ),
    # MiniMax language_boost lists none of the added Indian languages.
    "minimax": ProviderSpec("minimax", "MiniMax Speech", ("MINIMAX_API_KEY",), languages=ORIGINAL_16),
    "speechmatics": ProviderSpec(
        "speechmatics", "Speechmatics TTS (preview)", ("SPEECHMATICS_API_KEY",),
        languages=frozenset({"en"}),
    ),
}

LLM_SPECS: dict[str, ProviderSpec] = {
    "gemini": ProviderSpec("gemini", "Google Gemini", ("GEMINI_API_KEY",)),
    "groq": ProviderSpec("groq", "Groq", ("GROQ_API_KEY",)),
}

TRANSLATOR_SPECS: dict[str, ProviderSpec] = {
    "llm": ProviderSpec("llm", "LLM (Groq / Gemini)", ()),  # configured() overridden below
    "azure_translator": ProviderSpec("azure_translator", "Azure Translator", ()),
    "minimax": ProviderSpec("minimax", "MiniMax", ("MINIMAX_API_KEY",)),
}

SPECS: dict[str, dict[str, ProviderSpec]] = {
    "stt": STT_SPECS,
    "tts": TTS_SPECS,
    "llm": LLM_SPECS,
    "translator": TRANSLATOR_SPECS,
}

DEFAULT_ORDER: dict[str, list[str]] = {
    "stt": ["soniox", "deepgram", "speechmatics", "azure"],
    "tts": ["soniox", "azure", "deepgram", "minimax", "speechmatics"],
    "llm": ["gemini", "groq"],
    "translator": ["llm", "azure_translator", "minimax"],
}

ENV_DEFAULT_VAR = {
    "stt": "STT_PROVIDER",
    "tts": "TTS_PROVIDER",
    "llm": "LLM_PROVIDER",
    "translator": "TRANSLATION_PROVIDER",
}

# Model defaults are env-overridable; values verified against provider docs.
LLM_DEFAULTS: dict[str, dict[str, str]] = {
    # ai.google.dev models page (Nov 2026): gemini-2.5-* shut down 2026-12-01.
    "gemini": {
        "base_url_env": "GEMINI_BASE_URL",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model_env": "GEMINI_MODEL",
        "model": "gemini-3.8-flash",
        "fast_model_env": "GEMINI_FAST_MODEL",
        "fast_model": "gemini-3.5-flash-lite",
    },
    # console.groq.com/docs/models (Nov 2026): llama-3.x production models are deprecated.
    "groq": {
        "base_url_env": "GROQ_BASE_URL",
        "base_url": "https://api.groq.com/openai/v1",
        "model_env": "GROQ_MODEL",
        "model": "openai/gpt-oss-120b",
        "fast_model_env": "GROQ_FAST_MODEL",
        "fast_model": "openai/gpt-oss-20b",
    },
}


def _translator_configured(spec_id: str) -> bool:
    if spec_id == "llm":
        return any(s.configured() for s in LLM_SPECS.values())
    if spec_id == "azure_translator":
        return bool(os.getenv("AZURE_TRANSLATOR_KEY", "").strip() or os.getenv("AZURE_SPEECH_KEY", "").strip())
    return TRANSLATOR_SPECS[spec_id].configured()


def is_configured(kind: str, provider_id: str) -> bool:
    specs = SPECS[kind]
    if provider_id not in specs:
        return False
    if kind == "translator":
        return _translator_configured(provider_id)
    return specs[provider_id].configured()


def _missing_key_message(kind: str, provider_id: str) -> str:
    spec = SPECS[kind][provider_id]
    if kind == "translator" and provider_id == "llm":
        keys = "GEMINI_API_KEY or GROQ_API_KEY"
    elif kind == "translator" and provider_id == "azure_translator":
        keys = "AZURE_TRANSLATOR_KEY (or AZURE_SPEECH_KEY)"
    else:
        keys = " and ".join(spec.env_keys)
    return f"{spec.label} is not configured: set {keys} in backend/.env"


def resolve(
    kind: str, requested: str | None = None, *, language: str | None = None, require_auto: bool = False
) -> str:
    """Pick a configured provider id for `kind` (stt|tts|llm|translator).

    `require_auto` (STT): the provider must identify the spoken language itself.
    """
    specs = SPECS[kind]
    requested = (requested or "").strip().lower() or None
    if language and is_auto_language(language):
        language = None
    if requested and requested != "auto":
        if requested not in specs:
            raise ProviderConfigError(f"Unknown {kind} provider '{requested}'")
        if not is_configured(kind, requested):
            raise ProviderConfigError(_missing_key_message(kind, requested))
        if require_auto and not specs[requested].auto_language:
            raise ProviderConfigError(
                f"{specs[requested].label} can't auto-detect the spoken language - "
                "use Soniox or Deepgram, or pick the language the others speak"
            )
        if not specs[requested].supports(language):
            raise ProviderConfigError(f"{specs[requested].label} does not support language '{language}'")
        return requested

    env_default = os.getenv(ENV_DEFAULT_VAR[kind], "").strip().lower()
    candidates = ([env_default] if env_default in specs else []) + DEFAULT_ORDER[kind] + list(specs)
    seen: set[str] = set()
    for pid in candidates:
        if pid in seen:
            continue
        seen.add(pid)
        if is_configured(kind, pid) and specs[pid].supports(language) and (not require_auto or specs[pid].auto_language):
            if env_default and pid != env_default:
                logger.info("%s default '%s' unavailable; using '%s'", kind, env_default, pid)
            return pid
    hint = {
        "stt": "SONIOX_API_KEY, DEEPGRAM_API_KEY, SPEECHMATICS_API_KEY or AZURE_SPEECH_KEY",
        "tts": "SONIOX_API_KEY, AZURE_SPEECH_KEY, DEEPGRAM_API_KEY or MINIMAX_API_KEY",
        "llm": "GEMINI_API_KEY or GROQ_API_KEY",
        "translator": "GEMINI_API_KEY, GROQ_API_KEY, AZURE_TRANSLATOR_KEY or MINIMAX_API_KEY",
    }[kind]
    if require_auto:
        raise ProviderConfigError(
            "Auto-detecting the spoken language needs Soniox or Deepgram - add SONIOX_API_KEY or "
            "DEEPGRAM_API_KEY to backend/.env, or pick the language the others speak"
        )
    lang_note = f" for language '{language}'" if language else ""
    raise ProviderConfigError(f"No {kind.upper()} provider is configured{lang_note}. Add {hint} to backend/.env")


def tts_chain(requested: str | None, language: str) -> list[str]:
    """Primary TTS provider first, then every other configured one supporting `language`."""
    chain: list[str] = []
    try:
        chain.append(resolve("tts", requested, language=language))
    except ProviderConfigError:
        if requested and requested != "auto":
            raise
    for pid in DEFAULT_ORDER["tts"]:
        if pid not in chain and is_configured("tts", pid) and TTS_SPECS[pid].supports(language):
            chain.append(pid)
    if not chain:
        resolve("tts", None, language=language)  # raises with a helpful message
    return chain


def status() -> dict[str, Any]:
    out: dict[str, Any] = {}
    for kind, specs in SPECS.items():
        items = []
        for spec in specs.values():
            item = spec.public()
            item["configured"] = is_configured(kind, spec.id)
            items.append(item)
        try:
            default = resolve(kind)
        except ProviderConfigError:
            default = None
        out[kind] = {"providers": items, "default": default}
    out["memory"] = {"supermemory": bool(os.getenv("SUPERMEMORY_API_KEY", "").strip())}
    out["languages"] = sorted(APP_LANGUAGES)
    return out


# ── Factories ─────────────────────────────────────────────────────────


@dataclass
class SttCallbacks:
    on_transcript: Callable[..., Any]
    on_translation: Callable[..., Any] | None = None
    on_error: Callable[..., Any] | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def _build_soniox(language: str, target: str | None, cb: SttCallbacks):
    from services.providers.soniox_client import SonioxClient

    return SonioxClient(
        api_key=os.getenv("SONIOX_API_KEY", ""),
        language=language,
        target_language=target,
        on_transcript=cb.on_transcript,
        on_translation=cb.on_translation,
        on_error=cb.on_error,
    )


def _build_deepgram(language: str, target: str | None, cb: SttCallbacks):
    from services.providers.deepgram_client import DeepgramClient

    return DeepgramClient(
        api_key=os.getenv("DEEPGRAM_API_KEY", ""),
        language=language,
        on_transcript=cb.on_transcript,
        on_error=cb.on_error,
    )


def _build_speechmatics(language: str, target: str | None, cb: SttCallbacks):
    from services.speechmatics_client import SpeechmaticsClient

    return SpeechmaticsClient(
        api_key=os.getenv("SPEECHMATICS_API_KEY", ""),
        language=language,
        target_language=target,
        on_transcript=cb.on_transcript,
        on_translation=cb.on_translation if target else None,
        on_error=cb.on_error,
    )


def _build_azure(language: str, target: str | None, cb: SttCallbacks):
    from services.azure_translation_client import AzureTranslationClient

    return AzureTranslationClient(
        api_key=os.getenv("AZURE_SPEECH_KEY", ""),
        region=os.getenv("AZURE_SPEECH_REGION", "eastus"),
        language=language,
        # TranslationRecognizer needs a target; translations are dropped when not wanted.
        target_language=target or ("es" if language.startswith("en") else "en"),
        on_transcript=cb.on_transcript,
        on_translation=cb.on_translation if target else None,
        on_error=cb.on_error,
    )


def _build_azure_diarize(language: str, target: str | None, cb: SttCallbacks):
    from services.azure_conversation_client import AzureConversationClient

    return AzureConversationClient(
        api_key=os.getenv("AZURE_SPEECH_KEY", ""),
        region=os.getenv("AZURE_SPEECH_REGION", "eastus"),
        language=language,
        target_language=target,
        on_transcript=cb.on_transcript,
        on_translation=cb.on_translation if target else None,
        on_error=cb.on_error,
    )


STT_BUILDERS: dict[str, Callable[[str, str | None, SttCallbacks], Any]] = {
    "soniox": _build_soniox,
    "deepgram": _build_deepgram,
    "speechmatics": _build_speechmatics,
    "azure": _build_azure,
    "azure_diarize": _build_azure_diarize,
}


def build_stt(provider_id: str, *, language: str, target_language: str | None, callbacks: SttCallbacks):
    if provider_id not in STT_BUILDERS:
        raise ProviderConfigError(f"Unknown STT provider '{provider_id}'")
    if not is_configured("stt", provider_id):
        raise ProviderConfigError(_missing_key_message("stt", provider_id))
    return STT_BUILDERS[provider_id](language, target_language, callbacks)


def build_tts(provider_id: str):
    from services.providers import tts

    if provider_id not in tts.TTS_BUILDERS:
        raise ProviderConfigError(f"Unknown TTS provider '{provider_id}'")
    return tts.TTS_BUILDERS[provider_id]()


def llm_settings(provider_id: str, *, fast: bool = False) -> dict[str, str]:
    d = LLM_DEFAULTS[provider_id]
    model = os.getenv(d["fast_model_env"] if fast else d["model_env"], "").strip()
    if not model and fast:
        model = os.getenv(d["model_env"], "").strip() or d["fast_model"]
    return {
        "base_url": os.getenv(d["base_url_env"], "").strip() or d["base_url"],
        "model": model or d["model"],
        "api_key": os.getenv(LLM_SPECS[provider_id].env_keys[0], "").strip(),
    }


def _llm_extra(model: str, *, fast: bool) -> dict[str, Any]:
    # Groq gpt-oss models return a separate reasoning field; hide it and keep
    # latency low for live translation (console.groq.com/docs/reasoning).
    if model.startswith("openai/gpt-oss"):
        return {"include_reasoning": False, **({"reasoning_effort": "low"} if fast else {})}
    return {}


def build_llm(provider_id: str | None = None, *, fast: bool = False):
    from services.llm.openai_compat import OpenAICompatLLM

    pid = resolve("llm", provider_id)
    s = llm_settings(pid, fast=fast)
    return OpenAICompatLLM(
        provider=pid,
        base_url=s["base_url"],
        api_key=s["api_key"],
        model=s["model"],
        extra=_llm_extra(s["model"], fast=fast),
    )


def build_translator(provider_id: str | None = None):
    from services import text_translator

    pid = resolve("translator", provider_id)
    return text_translator.build(pid)
