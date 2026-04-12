"""
Smoke test: Azure Speech Translation (streaming, mic input).

Verifies that AZURE_SPEECH_KEY + AZURE_SPEECH_REGION in backend/.env can:
  1. Open a TranslationRecognizer against the Speech service
  2. Stream partial + final transcripts (English)
  3. Stream partial + final translations (English -> Spanish)
  4. Measure first-partial latency

Run from backend/:
    python scripts/test_azure_translation.py

Speaks into the default system microphone for ~15 seconds.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")

try:
    import azure.cognitiveservices.speech as speechsdk
except ImportError:
    print("ERROR: azure-cognitiveservices-speech is not installed.")
    print("Run: pip install azure-cognitiveservices-speech")
    sys.exit(1)


def main() -> int:
    key = os.getenv("AZURE_SPEECH_KEY", "").strip()
    region = os.getenv("AZURE_SPEECH_REGION", "").strip()

    if not key or not region:
        print("ERROR: AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must be set in backend/.env")
        return 2

    print(f"[setup] region={region}  key={key[:4]}****{key[-4:]}")
    print("[setup] source=en-US  target=es")

    translation_config = speechsdk.translation.SpeechTranslationConfig(
        subscription=key,
        region=region,
    )
    translation_config.speech_recognition_language = "en-US"
    translation_config.add_target_language("es")

    audio_config = speechsdk.audio.AudioConfig(use_default_microphone=True)

    recognizer = speechsdk.translation.TranslationRecognizer(
        translation_config=translation_config,
        audio_config=audio_config,
    )

    run_start = time.monotonic()
    first_partial_at: float | None = None
    first_final_at: float | None = None
    saw_any_event = False

    def elapsed_ms() -> int:
        return int((time.monotonic() - run_start) * 1000)

    def on_recognizing(evt: speechsdk.translation.TranslationRecognitionEventArgs) -> None:
        nonlocal first_partial_at, saw_any_event
        saw_any_event = True
        if first_partial_at is None:
            first_partial_at = time.monotonic()
            print(f"[{elapsed_ms():>6}ms] *** first partial arrived ***")
        es = evt.result.translations.get("es", "")
        print(f"[{elapsed_ms():>6}ms] PARTIAL  en='{evt.result.text}'  es='{es}'")

    def on_recognized(evt: speechsdk.translation.TranslationRecognitionEventArgs) -> None:
        nonlocal first_final_at, saw_any_event
        saw_any_event = True
        if evt.result.reason == speechsdk.ResultReason.TranslatedSpeech:
            if first_final_at is None:
                first_final_at = time.monotonic()
            es = evt.result.translations.get("es", "")
            print(f"[{elapsed_ms():>6}ms] FINAL    en='{evt.result.text}'  es='{es}'")
        elif evt.result.reason == speechsdk.ResultReason.NoMatch:
            print(f"[{elapsed_ms():>6}ms] NoMatch (silence or unintelligible)")

    def on_canceled(evt: speechsdk.translation.TranslationRecognitionCanceledEventArgs) -> None:
        print(f"[{elapsed_ms():>6}ms] CANCELED reason={evt.reason}")
        if evt.reason == speechsdk.CancellationReason.Error:
            print(f"          error_code={evt.error_code}")
            print(f"          error_details={evt.error_details}")

    def on_session_started(_evt) -> None:
        print(f"[{elapsed_ms():>6}ms] session started")

    def on_session_stopped(_evt) -> None:
        print(f"[{elapsed_ms():>6}ms] session stopped")

    recognizer.recognizing.connect(on_recognizing)
    recognizer.recognized.connect(on_recognized)
    recognizer.canceled.connect(on_canceled)
    recognizer.session_started.connect(on_session_started)
    recognizer.session_stopped.connect(on_session_stopped)

    print("\n>>> Speak English into your default microphone. Listening for 15 seconds...\n")

    recognizer.start_continuous_recognition()
    try:
        time.sleep(15)
    finally:
        recognizer.stop_continuous_recognition()

    print("\n─────────── summary ───────────")
    if not saw_any_event:
        print("NO events received. Check mic permission / key / region.")
        return 1

    if first_partial_at is not None:
        print(f"first partial latency:  {int((first_partial_at - run_start) * 1000)} ms from script start")
    if first_final_at is not None:
        print(f"first final latency:    {int((first_final_at - run_start) * 1000)} ms from script start")
    print("OK — Azure Speech Translation is reachable and streaming.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
