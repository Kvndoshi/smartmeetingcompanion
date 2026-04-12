# Azure Speech Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing Speechmatics (STT + translation) + MiniMax (LLM translation + TTS) pipeline with an Azure-only pipeline using `azure-cognitiveservices-speech` SDK. Keep Speechmatics/MiniMax code intact as opt-in fallback.

**Architecture:** Two new service clients (`AzureTranslationClient`, `AzureTtsClient`) matching the existing `SpeechmaticsClient` / `SpeechmaticsTTSClient` interface shapes, plus provider-flag dispatch in `main.py` (`STT_PROVIDER=azure|speechmatics`, `TTS_PROVIDER=azure|speechmatics|minimax`). No client-side changes; the WebSocket message contract is unchanged.

**Tech Stack:** Python 3.12, FastAPI, `azure-cognitiveservices-speech>=1.49.0`, pytest for unit tests, existing `speechmatics_client.py` as reference for the interface contract.

**Spec reference:** `docs/superpowers/specs/2026-04-11-azure-speech-pipeline-design.md`

---

## File Structure

New files:
- `backend/services/azure_tts_client.py` — wraps `SpeechSynthesizer`, picks neural voice per (language, gender)
- `backend/services/azure_translation_client.py` — wraps `TranslationRecognizer`, bridges callbacks to asyncio
- `backend/tests/__init__.py` — empty marker
- `backend/tests/test_azure_tts_client.py` — unit tests for `_pick_voice`
- `backend/tests/test_azure_translation_client.py` — unit tests for `_parse_gender`

Modified files:
- `backend/main.py` — provider dispatch in `websocket_translate`, updated `MANAGED_ENV_KEYS`
- `backend/pyproject.toml` — add `azure-cognitiveservices-speech>=1.49.0` + `pytest` dev dep
- `backend/.env` — document new keys (`STT_PROVIDER`, `TTS_PROVIDER`, voice overrides, endpointing knob)

Untouched (but referenced as fallback): `speechmatics_client.py`, `speechmatics_tts_client.py`, `minimax_client.py`.

---

## Task 1: `AzureTtsClient._pick_voice` with unit tests

**Files:**
- Create: `backend/tests/__init__.py`
- Create: `backend/tests/test_azure_tts_client.py`
- Create: `backend/services/azure_tts_client.py`

This task builds the pure voice-selection logic in isolation — no SDK calls. Establishes the file and the env-override contract before touching any network code.

- [ ] **Step 1: Create empty tests package marker**

Create `backend/tests/__init__.py` with zero content:

```python
```

- [ ] **Step 2: Write the failing test for `_pick_voice`**

Create `backend/tests/test_azure_tts_client.py`:

```python
"""Unit tests for AzureTtsClient pure helpers."""

from __future__ import annotations

import pytest

from services.azure_tts_client import AzureTtsClient


@pytest.fixture
def client() -> AzureTtsClient:
    return AzureTtsClient(api_key="dummy", region="eastus")


@pytest.mark.parametrize(
    "language,gender,expected",
    [
        ("en", "male", "en-US-SteffanNeural"),
        ("en", "female", "en-US-JennyNeural"),
        ("en", None, "en-US-JennyNeural"),
        ("es", "male", "es-ES-AlvaroNeural"),
        ("es", "female", "es-ES-ElviraNeural"),
        ("es", None, "es-ES-ElviraNeural"),
        ("zh", "male", "zh-CN-YunxiNeural"),
        ("zh", "female", "zh-CN-XiaoxiaoNeural"),
        ("fr", "female", "fr-FR-DeniseNeural"),
        ("de", "male", "de-DE-ConradNeural"),
        ("ja", "female", "ja-JP-NanamiNeural"),
    ],
)
def test_pick_voice_defaults(client: AzureTtsClient, language: str, gender, expected: str):
    assert client._pick_voice(language, gender) == expected


def test_pick_voice_unknown_lang_falls_back_to_english(client: AzureTtsClient):
    assert client._pick_voice("xx", "male") == "en-US-SteffanNeural"


def test_pick_voice_env_override(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("AZURE_TTS_VOICE_EN_FEMALE", "en-US-AriaNeural")
    client = AzureTtsClient(api_key="dummy", region="eastus")
    assert client._pick_voice("en", "female") == "en-US-AriaNeural"
    assert client._pick_voice("en", "male") == "en-US-SteffanNeural"  # male still default


def test_pick_voice_case_insensitive_gender(client: AzureTtsClient):
    assert client._pick_voice("en", "MALE") == "en-US-SteffanNeural"
    assert client._pick_voice("en", "Female") == "en-US-JennyNeural"
```

- [ ] **Step 3: Run the tests and confirm they fail with ImportError**

Run: `cd backend && python -m pytest tests/test_azure_tts_client.py -v`

Expected: `ModuleNotFoundError: No module named 'services.azure_tts_client'` or similar.

- [ ] **Step 4: Create minimal `azure_tts_client.py` with `_pick_voice` only**

Create `backend/services/azure_tts_client.py`:

```python
"""
Azure Neural TTS client.

Wraps azure.cognitiveservices.speech.SpeechSynthesizer with a
language + gender -> voice name picker and a simple async
`text_to_speech(text, language, gender_hint)` method.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("interpreter.azure_tts")


# (language, gender) -> Azure neural voice name.
# Female chosen as the fallback when gender is unknown.
_DEFAULT_VOICE_MAP: dict[tuple[str, str], str] = {
    ("en", "male"):   "en-US-SteffanNeural",
    ("en", "female"): "en-US-JennyNeural",
    ("es", "male"):   "es-ES-AlvaroNeural",
    ("es", "female"): "es-ES-ElviraNeural",
    ("fr", "male"):   "fr-FR-HenriNeural",
    ("fr", "female"): "fr-FR-DeniseNeural",
    ("de", "male"):   "de-DE-ConradNeural",
    ("de", "female"): "de-DE-KatjaNeural",
    ("it", "male"):   "it-IT-DiegoNeural",
    ("it", "female"): "it-IT-ElsaNeural",
    ("pt", "male"):   "pt-BR-AntonioNeural",
    ("pt", "female"): "pt-BR-FranciscaNeural",
    ("zh", "male"):   "zh-CN-YunxiNeural",
    ("zh", "female"): "zh-CN-XiaoxiaoNeural",
    ("ja", "male"):   "ja-JP-KeitaNeural",
    ("ja", "female"): "ja-JP-NanamiNeural",
    ("ko", "male"):   "ko-KR-InJoonNeural",
    ("ko", "female"): "ko-KR-SunHiNeural",
    ("hi", "male"):   "hi-IN-MadhurNeural",
    ("hi", "female"): "hi-IN-SwaraNeural",
    ("ar", "male"):   "ar-SA-HamedNeural",
    ("ar", "female"): "ar-SA-ZariyahNeural",
    ("ru", "male"):   "ru-RU-DmitryNeural",
    ("ru", "female"): "ru-RU-SvetlanaNeural",
}


class AzureTtsClient:
    """Azure Neural TTS wrapper.

    Accepts (language, gender_hint) and returns synthesized audio bytes.
    Voice selection is data-driven: defaults baked in per
    (language, gender), overridable per-pair via env var
    AZURE_TTS_VOICE_<LANG>_<GENDER>, e.g. AZURE_TTS_VOICE_EN_FEMALE.
    """

    def __init__(self, api_key: str, region: str):
        self.api_key = api_key
        self.region = region

    def _pick_voice(self, language: str, gender_hint: str | None) -> str:
        lang = (language or "en").strip().lower()
        gender = (gender_hint or "female").strip().lower()
        if gender not in {"male", "female"}:
            gender = "female"

        env_key = f"AZURE_TTS_VOICE_{lang.upper()}_{gender.upper()}"
        override = os.getenv(env_key, "").strip()
        if override:
            return override

        voice = _DEFAULT_VOICE_MAP.get((lang, gender))
        if voice:
            return voice

        # Unknown language — fall back to the English voice of the same gender.
        return _DEFAULT_VOICE_MAP[("en", gender)]
```

- [ ] **Step 5: Run tests — they should pass**

Run: `cd backend && python -m pytest tests/test_azure_tts_client.py -v`

Expected: all parametrized cases plus the three standalone tests pass. No warnings about the azure SDK.

- [ ] **Step 6: Commit**

```bash
git add backend/tests/__init__.py backend/tests/test_azure_tts_client.py backend/services/azure_tts_client.py
git commit -m "feat(azure-tts): add voice picker with unit tests"
```

---

## Task 2: `AzureTtsClient.text_to_speech` synthesis method

**Files:**
- Modify: `backend/services/azure_tts_client.py`

Adds the actual synthesis call. Runs the SDK call on a worker thread (the SDK is not asyncio-native).

- [ ] **Step 1: Edit `azure_tts_client.py` — add imports for the SDK**

Add at the top of the file, below `import os`:

```python
import asyncio

import azure.cognitiveservices.speech as speechsdk
```

- [ ] **Step 2: Add `text_to_speech` method to `AzureTtsClient`**

Append inside the `AzureTtsClient` class, below `_pick_voice`:

```python
    async def text_to_speech(
        self,
        text: str,
        language: str = "en",
        gender_hint: str | None = None,
    ) -> bytes | None:
        """Synthesize text into WAV/PCM bytes using Azure Neural TTS.

        Runs the sync Speech SDK call on a worker thread so it doesn't
        block the FastAPI event loop.
        """
        if not text.strip():
            return None
        if not self.api_key or not self.region:
            raise ValueError("Azure TTS requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION")

        voice_name = self._pick_voice(language, gender_hint)
        return await asyncio.to_thread(self._synthesize_blocking, text, voice_name)

    def _synthesize_blocking(self, text: str, voice_name: str) -> bytes | None:
        speech_config = speechsdk.SpeechConfig(subscription=self.api_key, region=self.region)
        speech_config.speech_synthesis_voice_name = voice_name
        speech_config.set_speech_synthesis_output_format(
            speechsdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm
        )

        synthesizer = speechsdk.SpeechSynthesizer(
            speech_config=speech_config,
            audio_config=None,  # no default speaker; return bytes
        )
        result = synthesizer.speak_text_async(text).get()

        if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
            logger.info(
                "Azure TTS synthesized %d bytes (voice=%s)",
                len(result.audio_data),
                voice_name,
            )
            return result.audio_data

        if result.reason == speechsdk.ResultReason.Canceled:
            cancellation = result.cancellation_details
            logger.error(
                "Azure TTS canceled: reason=%s error_code=%s details=%s",
                cancellation.reason,
                getattr(cancellation, "error_code", None),
                cancellation.error_details,
            )
            return None

        logger.warning("Azure TTS unexpected result reason: %s", result.reason)
        return None

    async def close(self) -> None:
        # Stateless per-call synthesizer; nothing to close at the client level.
        return None
```

- [ ] **Step 3: Verify unit tests still pass (import-time only; no live call)**

Run: `cd backend && python -m pytest tests/test_azure_tts_client.py -v`

Expected: same green tests as Task 1. The new `text_to_speech` code is import-compatible but untested at the unit level (it needs a live Azure call).

- [ ] **Step 4: Manual live sanity check — verify the SDK call path**

Run this one-liner in the backend dir (requires `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` already in `.env`):

```bash
cd backend && python -c "
import asyncio, os
from dotenv import load_dotenv
load_dotenv()
from services.azure_tts_client import AzureTtsClient

async def main():
    c = AzureTtsClient(os.environ['AZURE_SPEECH_KEY'], os.environ['AZURE_SPEECH_REGION'])
    audio = await c.text_to_speech('Hello from Azure.', 'en', 'female')
    assert audio and len(audio) > 1000, f'got {len(audio) if audio else 0} bytes'
    print(f'OK: {len(audio)} bytes')

asyncio.run(main())
"
```

Expected: `OK: <some number > 1000> bytes`. If this prints an error about auth, stop and fix the key before proceeding.

- [ ] **Step 5: Commit**

```bash
git add backend/services/azure_tts_client.py
git commit -m "feat(azure-tts): add synthesis method with thread-offload"
```

---

## Task 3: `AzureTranslationClient._parse_gender` pure function with tests

**Files:**
- Create: `backend/tests/test_azure_translation_client.py`
- Create: `backend/services/azure_translation_client.py`

Starts the translation client with just the pure JSON-parsing helper so it can be tested without the live SDK.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_azure_translation_client.py`:

```python
"""Unit tests for AzureTranslationClient pure helpers."""

from __future__ import annotations

import json

from services.azure_translation_client import AzureTranslationClient


def test_parse_gender_from_nbest_male():
    raw = json.dumps({
        "NBest": [
            {"Gender": "Male", "Display": "Hello"},
        ]
    })
    assert AzureTranslationClient._parse_gender(raw) == "male"


def test_parse_gender_from_nbest_female():
    raw = json.dumps({
        "NBest": [
            {"Gender": "Female", "Display": "Hello"},
        ]
    })
    assert AzureTranslationClient._parse_gender(raw) == "female"


def test_parse_gender_top_level_field():
    raw = json.dumps({"Gender": "male"})
    assert AzureTranslationClient._parse_gender(raw) == "male"


def test_parse_gender_missing_returns_none():
    raw = json.dumps({"Display": "Hello", "NBest": [{"Display": "Hello"}]})
    assert AzureTranslationClient._parse_gender(raw) is None


def test_parse_gender_empty_string_returns_none():
    assert AzureTranslationClient._parse_gender("") is None


def test_parse_gender_invalid_json_returns_none():
    assert AzureTranslationClient._parse_gender("not json {{") is None


def test_parse_gender_unexpected_value_returns_none():
    raw = json.dumps({"NBest": [{"Gender": "Robot"}]})
    assert AzureTranslationClient._parse_gender(raw) is None
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd backend && python -m pytest tests/test_azure_translation_client.py -v`

Expected: `ModuleNotFoundError: No module named 'services.azure_translation_client'`.

- [ ] **Step 3: Create minimal `azure_translation_client.py` with `_parse_gender` only**

Create `backend/services/azure_translation_client.py`:

```python
"""
Azure Speech Translation client.

Wraps azure.cognitiveservices.speech.translation.TranslationRecognizer
with the same callback shape as SpeechmaticsClient, so main.py can
switch providers with a single line change.
"""

from __future__ import annotations

import json
import logging

logger = logging.getLogger("interpreter.azure_translation")


class AzureTranslationClient:
    """Streaming STT + translation against Azure Speech Services."""

    @staticmethod
    def _parse_gender(raw_json: str) -> str | None:
        """Best-effort speaker gender extraction from an Azure result JSON blob.

        Azure does not guarantee the field exists. When present, it shows
        up either at the top level or inside NBest[0].Gender. Returns
        'male' / 'female' / None (anything else is None).
        """
        if not raw_json:
            return None
        try:
            payload = json.loads(raw_json)
        except (ValueError, TypeError):
            return None

        candidates: list[str] = []
        if isinstance(payload, dict):
            if isinstance(payload.get("Gender"), str):
                candidates.append(payload["Gender"])
            nbest = payload.get("NBest")
            if isinstance(nbest, list) and nbest:
                first = nbest[0]
                if isinstance(first, dict) and isinstance(first.get("Gender"), str):
                    candidates.append(first["Gender"])

        for raw in candidates:
            normalized = raw.strip().lower()
            if normalized in {"male", "female"}:
                return normalized
        return None
```

- [ ] **Step 4: Run the tests — all should pass**

Run: `cd backend && python -m pytest tests/test_azure_translation_client.py -v`

Expected: 7 passing tests.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/test_azure_translation_client.py backend/services/azure_translation_client.py
git commit -m "feat(azure-translation): add gender parser with unit tests"
```

---

## Task 4: `AzureTranslationClient` full wrapper (connect / send_audio / close)

**Files:**
- Modify: `backend/services/azure_translation_client.py`

Adds the live SDK plumbing: `PushAudioInputStream`, `TranslationRecognizer`, and the callback bridge into asyncio via `asyncio.run_coroutine_threadsafe`.

- [ ] **Step 1: Replace the existing `azure_translation_client.py` with the full implementation**

Overwrite `backend/services/azure_translation_client.py` with:

```python
"""
Azure Speech Translation client.

Wraps azure.cognitiveservices.speech.translation.TranslationRecognizer
with the same callback shape as SpeechmaticsClient, so main.py can
switch providers with a single line change.

Key points:
- PushAudioInputStream is fed from `send_audio(pcm_bytes)`.
- The SDK is sync/callback-based; we marshal every callback back to
  the caller's asyncio loop via run_coroutine_threadsafe.
- Best-effort speaker gender is captured from each recognition event
  and exposed via `self.last_speaker_gender` for the TTS layer.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Awaitable, Callable

import azure.cognitiveservices.speech as speechsdk

logger = logging.getLogger("interpreter.azure_translation")


# Source language code -> Azure BCP-47 locale used for recognition.
# Azure's speech_recognition_language requires a locale like "en-US",
# while the client app speaks in short codes like "en".
_SOURCE_LOCALE_MAP: dict[str, str] = {
    "en": "en-US",
    "es": "es-ES",
    "fr": "fr-FR",
    "de": "de-DE",
    "it": "it-IT",
    "pt": "pt-BR",
    "zh": "zh-CN",
    "ja": "ja-JP",
    "ko": "ko-KR",
    "ar": "ar-SA",
    "hi": "hi-IN",
    "ru": "ru-RU",
    "nl": "nl-NL",
    "sv": "sv-SE",
    "pl": "pl-PL",
    "tr": "tr-TR",
}

# Target language code sent to Azure's translation output.
# Azure's add_target_language takes the short form directly.
_TARGET_LANG_MAP: dict[str, str] = {code: code for code in _SOURCE_LOCALE_MAP.keys()}
_TARGET_LANG_MAP["zh"] = "zh-Hans"  # Azure prefers the script-tagged form for Chinese output


class AzureTranslationClient:
    """Streaming STT + translation against Azure Speech Services."""

    def __init__(
        self,
        api_key: str,
        region: str,
        language: str = "en",
        target_language: str | None = None,
        on_transcript: Callable[[str, bool], Awaitable[None]] | None = None,
        on_translation: Callable[[str, bool], Awaitable[None]] | None = None,
    ):
        self.api_key = api_key
        self.region = region
        self.source_locale = _SOURCE_LOCALE_MAP.get(language, language)
        self.target_lang = _TARGET_LANG_MAP.get(target_language, target_language) if target_language else None
        self.on_transcript = on_transcript
        self.on_translation = on_translation

        self.is_connected = False
        self.last_speaker_gender: str | None = None

        self._loop: asyncio.AbstractEventLoop | None = None
        self._push_stream: speechsdk.audio.PushAudioInputStream | None = None
        self._recognizer: speechsdk.translation.TranslationRecognizer | None = None

    # ──────────────── lifecycle ────────────────

    async def connect(self) -> None:
        if not self.api_key or not self.region:
            raise ValueError("Azure translation requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION")
        if not self.target_lang:
            raise ValueError("Azure translation requires a target_language")

        self._loop = asyncio.get_running_loop()

        translation_config = speechsdk.translation.SpeechTranslationConfig(
            subscription=self.api_key,
            region=self.region,
        )
        translation_config.speech_recognition_language = self.source_locale
        translation_config.add_target_language(self.target_lang)

        segmentation_ms = os.getenv("AZURE_SEGMENTATION_SILENCE_MS", "500").strip() or "500"
        translation_config.set_property(
            speechsdk.PropertyId.Speech_SegmentationSilenceTimeoutMs,
            segmentation_ms,
        )
        # Ask for detailed JSON so we can best-effort parse gender.
        translation_config.set_property(
            speechsdk.PropertyId.SpeechServiceResponse_RequestDetailedResultTrueFalse,
            "true",
        )
        translation_config.output_format = speechsdk.OutputFormat.Detailed

        audio_format = speechsdk.audio.AudioStreamFormat(
            samples_per_second=16000,
            bits_per_sample=16,
            channels=1,
        )
        self._push_stream = speechsdk.audio.PushAudioInputStream(stream_format=audio_format)
        audio_config = speechsdk.audio.AudioConfig(stream=self._push_stream)

        self._recognizer = speechsdk.translation.TranslationRecognizer(
            translation_config=translation_config,
            audio_config=audio_config,
        )

        self._recognizer.recognizing.connect(self._on_recognizing)
        self._recognizer.recognized.connect(self._on_recognized)
        self._recognizer.canceled.connect(self._on_canceled)
        self._recognizer.session_stopped.connect(self._on_session_stopped)

        self._recognizer.start_continuous_recognition()
        self.is_connected = True
        logger.info(
            "Azure translation connected (source=%s target=%s segmentation=%sms)",
            self.source_locale,
            self.target_lang,
            segmentation_ms,
        )

    async def send_audio(self, pcm_bytes: bytes) -> None:
        if not self.is_connected or self._push_stream is None:
            return
        try:
            self._push_stream.write(pcm_bytes)
        except (RuntimeError, OSError) as e:
            logger.error("Azure push_stream.write failed: %s", e)
            self.is_connected = False

    async def close(self) -> None:
        if not self.is_connected and self._recognizer is None:
            return
        self.is_connected = False
        try:
            if self._push_stream is not None:
                self._push_stream.close()
        except (RuntimeError, OSError):
            pass
        try:
            if self._recognizer is not None:
                self._recognizer.stop_continuous_recognition()
        except (RuntimeError, OSError) as e:
            logger.warning("Azure stop_continuous_recognition error: %s", e)
        self._push_stream = None
        self._recognizer = None
        logger.info("Azure translation closed")

    # ──────────────── SDK callbacks (run on SDK threads) ────────────────

    def _on_recognizing(self, evt: "speechsdk.translation.TranslationRecognitionEventArgs") -> None:
        transcript = evt.result.text or ""
        translation = ""
        if self.target_lang and evt.result.translations:
            translation = evt.result.translations.get(self.target_lang, "") or ""
        self._update_gender_from_event(evt)
        self._emit(transcript, translation, is_final=False)

    def _on_recognized(self, evt: "speechsdk.translation.TranslationRecognitionEventArgs") -> None:
        if evt.result.reason != speechsdk.ResultReason.TranslatedSpeech:
            return
        transcript = evt.result.text or ""
        translation = ""
        if self.target_lang and evt.result.translations:
            translation = evt.result.translations.get(self.target_lang, "") or ""
        self._update_gender_from_event(evt)
        self._emit(transcript, translation, is_final=True)

    def _on_canceled(self, evt: "speechsdk.translation.TranslationRecognitionCanceledEventArgs") -> None:
        logger.error(
            "Azure translation canceled: reason=%s error_code=%s details=%s",
            evt.reason,
            getattr(evt, "error_code", None),
            evt.error_details,
        )
        self.is_connected = False

    def _on_session_stopped(self, _evt) -> None:
        logger.info("Azure translation session stopped")
        self.is_connected = False

    # ──────────────── helpers ────────────────

    def _update_gender_from_event(self, evt) -> None:
        raw = evt.result.properties.get(
            speechsdk.PropertyId.SpeechServiceResponse_JsonResult
        )
        gender = self._parse_gender(raw or "")
        if gender:
            self.last_speaker_gender = gender

    def _emit(self, transcript: str, translation: str, is_final: bool) -> None:
        if self._loop is None:
            return
        if transcript and self.on_transcript is not None:
            asyncio.run_coroutine_threadsafe(
                self.on_transcript(transcript, is_final),
                self._loop,
            )
        if translation and self.on_translation is not None:
            asyncio.run_coroutine_threadsafe(
                self.on_translation(translation, is_final),
                self._loop,
            )

    @staticmethod
    def _parse_gender(raw_json: str) -> str | None:
        """Best-effort speaker gender extraction from an Azure result JSON blob."""
        if not raw_json:
            return None
        try:
            payload = json.loads(raw_json)
        except (ValueError, TypeError):
            return None

        candidates: list[str] = []
        if isinstance(payload, dict):
            if isinstance(payload.get("Gender"), str):
                candidates.append(payload["Gender"])
            nbest = payload.get("NBest")
            if isinstance(nbest, list) and nbest:
                first = nbest[0]
                if isinstance(first, dict) and isinstance(first.get("Gender"), str):
                    candidates.append(first["Gender"])

        for raw in candidates:
            normalized = raw.strip().lower()
            if normalized in {"male", "female"}:
                return normalized
        return None
```

- [ ] **Step 2: Re-run the unit tests — `_parse_gender` tests should still pass**

Run: `cd backend && python -m pytest tests/test_azure_translation_client.py -v`

Expected: 7 passing tests (same as Task 3; logic unchanged, just moved inside a fatter class).

- [ ] **Step 3: Commit**

```bash
git add backend/services/azure_translation_client.py
git commit -m "feat(azure-translation): add TranslationRecognizer wrapper"
```

---

## Task 5: Wire provider dispatch into `main.py`

**Files:**
- Modify: `backend/main.py`

Adds `STT_PROVIDER` / `TTS_PROVIDER` env switches, builds the right client, and removes the char-threshold buffering from the Azure path (since Azure already streams sentence finals).

- [ ] **Step 1: Update imports at the top of `main.py`**

In `backend/main.py`, find the block around line 23–26:

```python
from services.speechmatics_client import SpeechmaticsClient
from services.minimax_client import MinimaxClient, get_language_name
from services.speechmatics_tts_client import SpeechmaticsTTSClient
from services.profile_store import init_db, get_profile, upsert_profile, update_voice_profile, set_voice_status, list_profiles
```

Add two lines right after it:

```python
from services.azure_translation_client import AzureTranslationClient
from services.azure_tts_client import AzureTtsClient
```

- [ ] **Step 2: Extend `MANAGED_ENV_KEYS`**

Find `MANAGED_ENV_KEYS` (around line 57) and replace with:

```python
MANAGED_ENV_KEYS = [
    "SPEECHMATICS_API_KEY",
    "MINIMAX_API_KEY",
    "USE_SPEECHMATICS_TRANSLATION",
    "TTS_PROVIDER",
    "STT_PROVIDER",
    "TRANSLATION_TRIGGER_CHAR_THRESHOLD",
    "SPEECHMATICS_MAX_DELAY",
    "SPEECHMATICS_RT_WS_URL",
    "AZURE_SPEECH_KEY",
    "AZURE_SPEECH_REGION",
    "AZURE_SEGMENTATION_SILENCE_MS",
]
```

- [ ] **Step 3: Add provider env reads in `websocket_translate`**

In `backend/main.py`, inside `websocket_translate`, find the block that reads env vars (around lines 233–248, starting with `speechmatics_key = os.getenv(...)`). Immediately after the `translation_partial_min_interval = ...` line, add:

```python
    stt_provider = os.getenv("STT_PROVIDER", "azure").strip().lower() or "azure"
    if stt_provider not in {"azure", "speechmatics"}:
        stt_provider = "azure"

    azure_key = os.getenv("AZURE_SPEECH_KEY", "")
    azure_region = os.getenv("AZURE_SPEECH_REGION", "eastus")
```

Also change the `tts_provider` default (around line 239) from:

```python
    tts_provider = os.getenv("TTS_PROVIDER", "speechmatics").strip().lower() or "speechmatics"
```

to:

```python
    tts_provider = os.getenv("TTS_PROVIDER", "azure").strip().lower() or "azure"
```

- [ ] **Step 4: Add the Azure TTS client alongside the other clients**

Find (around line 250–252):

```python
    speechmatics: SpeechmaticsClient | None = None
    minimax = MinimaxClient(api_key=minimax_key, group_id=minimax_group_id)
    speechmatics_tts = SpeechmaticsTTSClient(api_key=speechmatics_key)
```

Change the declared type of `speechmatics` to allow either client, and instantiate `azure_tts`:

```python
    stt_client: SpeechmaticsClient | AzureTranslationClient | None = None
    minimax = MinimaxClient(api_key=minimax_key, group_id=minimax_group_id)
    speechmatics_tts = SpeechmaticsTTSClient(api_key=speechmatics_key)
    azure_tts = AzureTtsClient(api_key=azure_key, region=azure_region)
```

Then, in the `finally` block at the bottom of `websocket_translate` (near line 549–552), find:

```python
        if speechmatics:
            await speechmatics.close()
        await speechmatics_tts.close()
        await minimax.close()
```

and replace with:

```python
        if stt_client:
            await stt_client.close()
        await speechmatics_tts.close()
        await minimax.close()
        await azure_tts.close()
```

- [ ] **Step 5: Replace all remaining references to `speechmatics` in the handler with `stt_client`**

Search the function body for `speechmatics` (the local variable) and rename — but only inside `websocket_translate`. The references to change:

- `speechmatics: SpeechmaticsClient | None = None` — already done above.
- `if speechmatics:` → `if stt_client:`
- `if speechmatics and speechmatics.is_connected:` → `if stt_client and stt_client.is_connected:`
- `await speechmatics.send_audio(...)` → `await stt_client.send_audio(...)`
- `if speechmatics: await speechmatics.close()` — already done above.
- `speechmatics = SpeechmaticsClient(...)` → handled in Step 6.

Leave the env-var names (`speechmatics_key`, `SPEECHMATICS_*`) and the other module-level `SpeechmaticsClient` imports untouched.

- [ ] **Step 6: Build the STT client based on `stt_provider` inside the config handler**

Inside the `if msg.get("type") == "config":` block (around lines 495–520), replace the STT initialization block:

```python
                    # Initialize Speechmatics with the source language
                    if speechmatics:
                        await speechmatics.close()

                    speechmatics = SpeechmaticsClient(
                        api_key=speechmatics_key,
                        language=source_lang,
                        target_language=target_lang if use_speechmatics_translation else None,
                        on_transcript=on_transcript,
                        on_translation=on_translation if use_speechmatics_translation else None,
                    )
                    await speechmatics.connect()
                    logger.info("Speechmatics connected")
```

with:

```python
                    if stt_client:
                        await stt_client.close()

                    if stt_provider == "azure":
                        stt_client = AzureTranslationClient(
                            api_key=azure_key,
                            region=azure_region,
                            language=source_lang,
                            target_language=target_lang,
                            on_transcript=on_transcript,
                            on_translation=on_translation,
                        )
                    else:
                        stt_client = SpeechmaticsClient(
                            api_key=speechmatics_key,
                            language=source_lang,
                            target_language=target_lang if use_speechmatics_translation else None,
                            on_transcript=on_transcript,
                            on_translation=on_translation if use_speechmatics_translation else None,
                        )
                    await stt_client.connect()
                    logger.info("STT client connected: provider=%s", stt_provider)
```

- [ ] **Step 7: Skip the char-buffer path when using Azure**

In `on_transcript` (around lines 308–339), the current logic routes finals into the `transcript_buffer` when `use_speechmatics_translation` is False, and translates via MiniMax when the buffer fills. With Azure, translation streams alongside transcription and the buffering is redundant.

Find:

```python
            if is_final and text.strip():
                if use_speechmatics_translation:
                    return

                transcript_buffer += " " + text.strip()
```

and change the guard so Azure also short-circuits the MiniMax path:

```python
            if is_final and text.strip():
                # Azure + Speechmatics translation modes handle translation inline
                # via on_translation; only the MiniMax LLM path needs buffering.
                if stt_provider == "azure" or use_speechmatics_translation:
                    return

                transcript_buffer += " " + text.strip()
```

- [ ] **Step 8: Route `synthesize_tts` through the new provider dispatch**

Replace the existing `synthesize_tts` function (around lines 363–380) with:

```python
    async def synthesize_tts(translated_text: str) -> bytes | None:
        gender_hint: str | None = None
        if isinstance(stt_client, AzureTranslationClient):
            gender_hint = stt_client.last_speaker_gender

        if tts_provider == "azure":
            audio_data = await azure_tts.text_to_speech(
                text=translated_text,
                language=target_lang,
                gender_hint=gender_hint,
            )
            if audio_data:
                return audio_data
            logger.warning(
                "Azure TTS returned no audio for target language '%s'; "
                "falling back to MiniMax TTS.",
                target_lang,
            )

        if tts_provider == "speechmatics":
            audio_data = await speechmatics_tts.text_to_speech(
                text=translated_text,
                language=target_lang,
            )
            if audio_data:
                return audio_data
            logger.warning(
                "Speechmatics TTS returned no audio for target language '%s'; "
                "falling back to MiniMax TTS.",
                target_lang,
            )

        return await minimax.text_to_speech(
            text=translated_text,
            language=target_lang,
        )
```

- [ ] **Step 9: Import-check the edited file**

Run: `cd backend && python -c "import main; print('ok')"`

Expected: `ok`. If you get an `ImportError` or `SyntaxError`, fix it before continuing. Common cause: a stale `speechmatics` reference that wasn't renamed.

- [ ] **Step 10: Commit**

```bash
git add backend/main.py
git commit -m "feat(main): dispatch STT/TTS via provider flags, default to azure"
```

---

## Task 6: Dependencies, env scaffolding, and `/api/settings` awareness

**Files:**
- Modify: `backend/pyproject.toml`
- Modify: `backend/.env`

- [ ] **Step 1: Add Azure Speech SDK + pytest to `pyproject.toml`**

Replace the `[project]` block in `backend/pyproject.toml` with:

```toml
[project]
name = "interpreter-backend"
version = "1.0.0"
description = "FastAPI WebSocket backend for live speaker translation"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.32.0",
    "websockets>=13.0",
    "httpx>=0.28.0",
    "python-dotenv>=1.0.0",
    "azure-cognitiveservices-speech>=1.49.0",
]

[dependency-groups]
dev = [
    "pytest>=8.0",
]
```

- [ ] **Step 2: Add documented env-key defaults to `backend/.env`**

Append (do not replace) the following block to `backend/.env`, keeping the existing Azure key/region lines untouched:

```
# ── Provider selection (new Azure-first pipeline) ──
# STT_PROVIDER: azure | speechmatics   (Azure uses Speech Translation — STT+translate in one stream)
# TTS_PROVIDER: azure | speechmatics | minimax
STT_PROVIDER=azure
TTS_PROVIDER=azure

# Azure endpointing — ms of silence before finalizing a segment.
# Default 500 matches Azure's built-in endpointing. Lower (~300) = snappier finals,
# higher (~800) = safer segmentation for long pauses.
AZURE_SEGMENTATION_SILENCE_MS=500

# Optional Azure Neural TTS voice overrides. Defaults bake in sensible voices per
# (language, gender); set any of these to pin a specific voice.
# AZURE_TTS_VOICE_EN_MALE=en-US-SteffanNeural
# AZURE_TTS_VOICE_EN_FEMALE=en-US-JennyNeural
# AZURE_TTS_VOICE_ES_MALE=es-ES-AlvaroNeural
# AZURE_TTS_VOICE_ES_FEMALE=es-ES-ElviraNeural
# AZURE_TTS_VOICE_ZH_MALE=zh-CN-YunxiNeural
# AZURE_TTS_VOICE_ZH_FEMALE=zh-CN-XiaoxiaoNeural
```

- [ ] **Step 3: Verify pyproject.toml parses**

Run: `cd backend && python -c "import tomllib; tomllib.loads(open('pyproject.toml','rb').read().decode()); print('ok')"`

Expected: `ok`.

- [ ] **Step 4: Run the full unit-test suite once more**

Run: `cd backend && python -m pytest tests -v`

Expected: all tests from Tasks 1 and 3 pass (voice picker + gender parser). No collection errors.

- [ ] **Step 5: Commit**

```bash
git add backend/pyproject.toml backend/.env
git commit -m "chore: add azure-speech dep, document provider env keys"
```

---

## Task 7: End-to-end live smoke test

**Files:**
- None modified. Live verification only.

- [ ] **Step 1: Start the backend**

Run in one terminal: `cd backend && python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload`

Expected: `Interpreter backend starting...`, `SQLite profile store initialized`, `Uvicorn running on http://127.0.0.1:8000`. If the backend fails to start with an Azure SDK import error, re-run `pip install azure-cognitiveservices-speech` in the same Python environment and try again.

- [ ] **Step 2: Verify `/api/settings` exposes the new keys**

In a second terminal:

```bash
curl -s http://127.0.0.1:8000/api/settings
```

Expected: JSON containing `STT_PROVIDER`, `TTS_PROVIDER`, `AZURE_SPEECH_KEY` (masked), `AZURE_SPEECH_REGION`, `AZURE_SEGMENTATION_SILENCE_MS`.

- [ ] **Step 3: Open the Chrome extension and start a translation session**

Click the extension, pick source `en` → target `es` (or `zh` → `en` to mirror the motivating use case). Speak a few sentences.

Expected in backend logs:
- `STT client connected: provider=azure`
- `Azure translation connected (source=en-US target=es segmentation=500ms)`
- Transcript + translated_text messages being sent
- `Azure TTS synthesized <N> bytes (voice=es-ES-ElviraNeural)` (or matching voice)

Expected in the extension: live captions populate and translated audio plays back within ~1 second of each sentence you finish speaking.

- [ ] **Step 4: Fallback sanity check — flip back to the old pipeline**

Stop the backend. Edit `backend/.env`:

```
STT_PROVIDER=speechmatics
TTS_PROVIDER=speechmatics
```

Restart uvicorn and verify a translation session still works — this proves the rollback path is intact.

Set the values back to `azure` when done.

- [ ] **Step 5: Final commit — mark the feature shipped (if anything else was tweaked)**

If any small tweak was needed (log format, typo, voice override), commit it:

```bash
git add -u
git commit -m "chore: post-integration fixups"
```

If nothing needed tweaking, skip this step.

---

## Self-Review

**Spec coverage:**
- Architecture diagram → Tasks 4–5 implement the data flow
- `services/azure_translation_client.py` → Tasks 3 + 4
- `services/azure_tts_client.py` → Tasks 1 + 2
- `main.py` provider dispatch + buffer-skip → Task 5
- `.env` additions → Task 6
- `pyproject.toml` dep → Task 6
- Gender detection → Task 3 (pure), Task 4 (wired into events), Task 5 (passed to TTS)
- Endpointing knob `AZURE_SEGMENTATION_SILENCE_MS` → Task 4 (applied), Task 6 (documented), Task 5 (exposed via MANAGED_ENV_KEYS)
- Rollback path → Task 7 Step 4 verifies
- Non-goals (no cloning, no diarization, no TTS chunk-streaming) → respected, not implemented
- Testing layers → unit tests Tasks 1 + 3, live smoke Task 2 Step 4 + Task 7

**Placeholder scan:** No TBDs, TODOs, "fill in", "similar to above", or "handle edge cases" — every code block is complete and self-contained.

**Type consistency:** `AzureTtsClient(api_key, region)` constructor, `_pick_voice(language, gender_hint)`, `text_to_speech(text, language, gender_hint)` — consistent across Tasks 1, 2, 5. `AzureTranslationClient(api_key, region, language, target_language, on_transcript, on_translation)` — consistent across Tasks 3, 4, 5. `last_speaker_gender` attribute used in Task 4 and referenced in Task 5 Step 8.

**Scope check:** All tasks stay within the single spec. No scope creep into cloning, diarization, chunk streaming, or refactoring unrelated code.
