// Run with: npm test  (Node 24 runs TypeScript directly via type stripping)
import { test } from "node:test";
import assert from "node:assert/strict";

import { MIN_SWITCH_GAP_MS, ROOM_WINDOW_MS, emptyRoom, observeRoom, type RoomState } from "../src/shared/roomLanguage.ts";

const HI = "आज की मीटिंग में बजट पर बात करेंगे"; // > 12 chars
const GU = "આજે આપણે બજેટ વિશે વાત કરીશું";
const EN = "Let's talk about the budget today";

function feed(state: RoomState, items: [string | null, string, number][], myLang = "en"): RoomState {
  for (const [lang, text, t] of items) state = observeRoom(state, { lang, text, t }, myLang);
  return state;
}

test("starts unknown: others hear my own voice", () => {
  assert.equal(emptyRoom().current, null);
});

test("picks the room language after two consistent segments", () => {
  let s = feed(emptyRoom(), [["hi", HI, 1_000]]);
  assert.equal(s.current, null, "one segment is not enough");
  s = feed(s, [["hi", HI, 2_000]]);
  assert.equal(s.current, "hi");
});

test("a room speaking my language means no translation", () => {
  const s = feed(emptyRoom(), [["en", EN, 1_000], ["en", EN, 2_000], ["en-US", EN, 3_000]]);
  assert.equal(s.current, null);
});

test("short or untagged segments are ignored", () => {
  const s = feed(emptyRoom(), [["hi", "हाँ", 1_000], [null, HI, 2_000], ["hi", "ठीक", 3_000]]);
  assert.equal(s.samples.length, 0);
  assert.equal(s.current, null);
});

test("one stray sentence does not flip the room", () => {
  let s = feed(emptyRoom(), [["hi", HI, 1_000], ["hi", HI, 2_000], ["hi", HI, 3_000]]);
  assert.equal(s.current, "hi");
  s = feed(s, [["gu", GU, 30_000]]);
  assert.equal(s.current, "hi");
});

test("no clear majority keeps the current choice", () => {
  let s = feed(emptyRoom(), [["hi", HI, 1_000], ["hi", HI, 2_000]]);
  s = feed(s, [["gu", GU, 40_000], ["gu", GU, 41_000]]); // ~50/50 → below 60%
  assert.equal(s.current, "hi");
});

test("switches when the room changes, but not faster than the minimum gap", () => {
  let s = feed(emptyRoom(), [["hi", HI, 1_000], ["hi", HI, 2_000]]);
  assert.equal(s.current, "hi");
  // Hindi speech ages out of the window; Gujarati takes over.
  const later = 2_000 + ROOM_WINDOW_MS + 1;
  s = feed(s, [["gu", GU, later], ["gu", GU, later + 1_000]]);
  assert.equal(s.current, "gu");
  // Later the room moves to my language (English) → back to my own voice.
  const after = later + ROOM_WINDOW_MS + 2_000;
  s = feed(s, [["en", EN, after], ["en", EN, after + 1_000]]);
  assert.equal(s.current, null);
});

test("respects the minimum gap between switches", () => {
  let s = feed(emptyRoom(), [["hi", HI, 1_000], ["hi", HI, 2_000]]);
  assert.equal(s.current, "hi");
  const t = 2_000 + ROOM_WINDOW_MS + 1; // window cleared, but well past the gap anyway
  s = feed(s, [["gu", GU, t], ["gu", GU, t + 1]]);
  assert.equal(s.current, "gu");
  const tooSoon = t + 2; // within MIN_SWITCH_GAP_MS of the last switch
  let quick = { ...s, samples: [] };
  quick = feed(quick, [["hi", HI, tooSoon], ["hi", HI, tooSoon + 1]]);
  assert.equal(quick.current, "gu");
  quick = feed(quick, [["hi", HI, t + 1 + MIN_SWITCH_GAP_MS]]);
  assert.equal(quick.current, "hi");
});
