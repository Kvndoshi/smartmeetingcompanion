"""Scoring helpers for the end-to-end evaluation (WER, keyword grading, audio).

Kept free of network code so the scoring itself is unit-tested
(tests/test_evaluation.py) with zero API keys.
"""

from __future__ import annotations

import re
from array import array
from typing import Any, Iterable

_SMALL = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
_ORDINALS = {
    "first": 1, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9,
    "tenth": 10, "eleventh": 11, "twelfth": 12, "thirteenth": 13, "fourteenth": 14, "fifteenth": 15,
    "sixteenth": 16, "seventeenth": 17, "eighteenth": 18, "nineteenth": 19, "twentieth": 20, "thirtieth": 30,
}
_SPELLING = {"okay": "ok", "alright": "all right", "percent": "percent", "e-mail": "email"}


def _words_to_numbers(tokens: list[str]) -> list[str]:
    out: list[str] = []
    total = current = 0
    active = False

    def flush() -> None:
        nonlocal total, current, active
        if active:
            out.append(str(total + current))
        total = current = 0
        active = False

    for tok in tokens:
        if tok in _SMALL:
            current += _SMALL[tok]
            active = True
        elif tok in _TENS:
            current += _TENS[tok]
            active = True
        elif tok in _ORDINALS:
            current += _ORDINALS[tok]
            active = True
            flush()
        elif tok == "hundred" and active:
            current = max(current, 1) * 100
        elif tok == "thousand" and active:
            total += max(current, 1) * 1000
            current = 0
        elif tok.isdigit() and active and tok != "0":
            # e.g. "twelve 000" never happens; treat as a new number
            flush()
            out.append(tok)
        else:
            flush()
            out.append(tok)
    flush()
    return out


def normalize(text: str) -> str:
    """Lowercase, strip punctuation and canonicalise numbers for fair WER/keyword checks."""
    t = text.lower()
    t = re.sub(r"(?<=\d),(?=\d{3}\b)", "", t)  # 12,000 -> 12000
    t = re.sub(r"\$\s*(\d+(?:\.\d+)?)\s*k\b", lambda m: str(int(float(m.group(1)) * 1000)), t)  # $12k
    t = t.replace("%", " percent ").replace("$", " ")
    t = re.sub(r"\b([ap])\.?\s?m\b\.?", r"\1m", t)  # a.m. / a m -> am
    t = re.sub(r"(\d+)(st|nd|rd|th)\b", r"\1", t)  # 14th -> 14
    t = t.replace("-", " ").replace("'", "").replace("’", "")
    t = re.sub(r"[^\w\s]", " ", t)
    tokens = [_SPELLING.get(tok, tok) for tok in t.split()]
    tokens = _words_to_numbers(" ".join(tokens).split())
    joined = " ".join(tokens)
    joined = re.sub(r"\b(\d+) 000\b", lambda m: str(int(m.group(1)) * 1000), joined)
    return joined


def word_error_rate(reference: str, hypothesis: str) -> dict[str, Any]:
    ref = normalize(reference).split()
    hyp = normalize(hypothesis).split()
    n, m = len(ref), len(hyp)
    if n == 0:
        return {"wer": 0.0 if m == 0 else 1.0, "ref_words": 0, "hyp_words": m, "sub": 0, "del": 0, "ins": m}
    # Levenshtein with backtrace counts (sub, del, ins).
    prev = [(j, 0, 0, j) for j in range(m + 1)]  # (cost, sub, del, ins)
    for i in range(1, n + 1):
        cur = [(i, 0, i, 0)] + [None] * m  # type: ignore[list-item]
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                cur[j] = prev[j - 1]
                continue
            s, d, ins = prev[j - 1], prev[j], cur[j - 1]
            best = min(
                (s[0] + 1, s[1] + 1, s[2], s[3]),
                (d[0] + 1, d[1], d[2] + 1, d[3]),
                (ins[0] + 1, ins[1], ins[2], ins[3] + 1),
            )
            cur[j] = best
        prev = cur
    cost, sub, dele, ins = prev[m]
    return {"wer": cost / n, "ref_words": n, "hyp_words": m, "sub": sub, "del": dele, "ins": ins}


def contains_phrase(text_norm: str, phrase: str) -> bool:
    p = normalize(phrase)
    # Words may take a suffix ("6 week" ~ "6 weeks"); numbers must end ("10" !~ "100").
    tail = r"(?!\d)" if p[-1:].isdigit() else ""
    return bool(p) and re.search(rf"(?<!\w){re.escape(p)}{tail}", text_norm) is not None


def match_groups(text: str, groups: Iterable[Iterable[str]]) -> bool:
    """True when every group has at least one alternative present in `text`."""
    norm = normalize(text)
    return all(any(contains_phrase(norm, alt) for alt in group) for group in groups)


def grade_summary(summary: dict[str, Any], expected_decisions: list[dict], expected_actions: list[dict]) -> dict[str, Any]:
    decisions_text = "\n".join(summary.get("decisions") or [])
    everything = "\n".join(
        [summary.get("overview") or "", decisions_text, "\n".join(summary.get("key_points") or []), "\n".join(summary.get("next_steps") or [])]
        + [f"{a.get('task')} {a.get('owner') or ''} {a.get('due') or ''}" for a in summary.get("action_items") or []]
    )
    decisions = []
    for exp in expected_decisions:
        in_list = match_groups(decisions_text, exp["keywords"])
        decisions.append({"label": exp["label"], "found": in_list, "mentioned_elsewhere": not in_list and match_groups(everything, exp["keywords"])})
    actions = []
    items = summary.get("action_items") or []
    for exp in expected_actions:
        hit = next((a for a in items if match_groups(f"{a.get('task')} {a.get('due') or ''}", exp["keywords"])), None)
        owner_ok = bool(hit and exp.get("owner") and exp["owner"] in normalize(str(hit.get("owner") or "")))
        actions.append({"label": exp["label"], "found": hit is not None, "owner_correct": owner_ok, "matched": hit})
    found = sum(d["found"] for d in decisions) + sum(a["found"] for a in actions)
    total = len(decisions) + len(actions)
    return {"decisions": decisions, "action_items": actions, "found": found, "total": total, "all_captured": found == total}


def token_f1(a: str, b: str) -> float:
    ta, tb = normalize(a).split(), normalize(b).split()
    if not ta or not tb:
        return 0.0
    from collections import Counter

    common = sum((Counter(ta) & Counter(tb)).values())
    if common == 0:
        return 0.0
    p, r = common / len(tb), common / len(ta)
    return 2 * p * r / (p + r)


def chunks(data: bytes, size: int) -> list[bytes]:
    return [data[i : i + size] for i in range(0, len(data), size)]


def resample_pcm16(pcm: bytes, src_rate: int, dst_rate: int = 16000, channels: int = 1) -> bytes:
    """Linear-interpolation resample of little-endian Int16 PCM to mono `dst_rate`."""
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if channels > 1:
        samples = array("h", (int(sum(samples[i : i + channels]) / channels) for i in range(0, len(samples) - channels + 1, channels)))
    if src_rate == dst_rate or not samples:
        return samples.tobytes()
    ratio = src_rate / dst_rate
    out_len = int(len(samples) / ratio)
    out = array("h", [0]) * out_len
    last = len(samples) - 1
    for i in range(out_len):
        pos = i * ratio
        j = int(pos)
        frac = pos - j
        nxt = samples[j + 1] if j < last else samples[last]
        out[i] = int(samples[j] + (nxt - samples[j]) * frac)
    return out.tobytes()
