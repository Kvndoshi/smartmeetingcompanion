"""The E2E scorer must itself be right: WER, number normalisation, keyword grading."""

from __future__ import annotations

import json
from array import array
from pathlib import Path

from scripts.evaluation import grade_summary, match_groups, normalize, resample_pcm16, token_f1, word_error_rate

SCRIPT = json.loads((Path(__file__).resolve().parent.parent / "fixtures" / "meeting_script.json").read_text(encoding="utf-8"))


def test_normalize_numbers_and_punctuation():
    assert normalize("Launch moves to October 14th.") == normalize("launch moves to october fourteenth")
    assert normalize("It costs around $12,000.") == normalize("it costs around twelve thousand dollars").replace(" dollars", "")
    assert normalize("about 400 beta testers") == normalize("about four hundred beta testers")
    assert normalize("Thursdays at 10 AM") == normalize("thursdays at ten a.m.")
    assert normalize("Let's do it, in-house!") == "lets do it in house"
    assert normalize("thirty-first") == "31"


def test_wer_counts_edits():
    r = word_error_rate("the launch moves to october 14", "the launch moved to October fourteenth")
    assert r["ref_words"] == 6 and r["sub"] == 1 and r["wer"] == 1 / 6
    r = word_error_rate("a b c d", "a c d e")
    assert (r["del"], r["ins"]) == (1, 1) and r["wer"] == 0.5
    assert word_error_rate("hello", "hello")["wer"] == 0.0


def test_reference_vs_typical_stt_formatting_is_close():
    reference = " ".join(line["text"] for line in SCRIPT["lines"])
    # Typical STT output: different casing, punctuation, number formats.
    hyp = (
        reference.replace("October 14th", "October fourteenth")
        .replace("$12,000", "12000 dollars")
        .replace("10 AM", "10 a.m.")
        .replace("Okay.", "OK,")
    )
    assert word_error_rate(reference, hyp)["wer"] < 0.02


def test_keyword_groups_and_word_boundaries():
    assert match_groups("We hire a QA tester for 6 weeks", [["qa", "tester"], ["six week", "6 week"]])
    assert not match_groups("meeting at 100 people", [["10"]])
    assert match_groups("Thursdays at 10 AM", [["thursday"], ["10"]])


def test_grade_summary_against_expected():
    summary = {
        "decisions": [
            "The launch moves from September 30th to October 14th.",
            "Use Stripe for payments instead of building in-house.",
            "Hire one contract QA tester for six weeks.",
            "Weekly status meeting moves to Thursdays at 10 a.m.",
        ],
        "action_items": [
            {"task": "Finish the Stripe payment integration", "owner": "Daniel", "due": "October 3rd"},
            {"task": "Send the updated launch plan to the marketing team", "owner": "Maya", "due": "Friday"},
            {"task": "Post the QA contractor job listing", "owner": "Daniel", "due": "Wednesday"},
            {"task": "Fix the Android login crash before the beta build", "owner": "Daniel", "due": "Monday"},
            {"task": "Schedule a design review with Priya", "owner": "Maya (Speaker 1)", "due": "next Tuesday"},
        ],
    }
    graded = grade_summary(summary, SCRIPT["expected_decisions"], SCRIPT["expected_action_items"])
    assert graded["all_captured"], graded
    assert all(a["owner_correct"] for a in graded["action_items"])

    summary["decisions"].pop(1)
    graded = grade_summary(summary, SCRIPT["expected_decisions"], SCRIPT["expected_action_items"])
    assert graded["found"] == graded["total"] - 1
    assert next(d for d in graded["decisions"] if "Stripe" in d["label"])["mentioned_elsewhere"] is True


def test_qa_keywords_accept_expected_answers():
    for item in SCRIPT["qa"]:
        assert match_groups(item["a"], item["keywords"]), item
        assert not match_groups("I couldn't find that in the meeting notes.", item["keywords"]), item


def test_token_f1_and_resample():
    assert token_f1("el lanzamiento se mueve", "El lanzamiento se mueve.") == 1.0
    assert token_f1("abc", "xyz") == 0.0
    tone = array("h", [1000, -1000] * 1200).tobytes()  # 2400 samples @ 24 kHz = 0.1 s
    out = resample_pcm16(tone, 24000, 16000)
    assert len(out) == 1600 * 2
    stereo = array("h", [100, 300] * 160).tobytes()
    assert array("h", resample_pcm16(stereo, 16000, 16000, channels=2))[0] == 200
