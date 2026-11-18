// "Auto — match the room": which language do the other participants speak?
//
// Fed with the finalized transcript segments of the tab audio (everyone but you)
// and their detected language. Pure functions, no chrome.* — unit-tested in
// extension/tests/roomLanguage.test.ts. Keep this file free of imports so Node
// can run it directly.
//
// The answer is the language others should hear you in, or null for "your own
// voice": when the room mostly speaks your language, or nothing is known yet.

export const ROOM_WINDOW_MS = 180_000; // only the last 3 minutes count
export const MIN_SEGMENT_CHARS = 12; // "ok", "haan", "yes" say little about the room
export const MIN_SHARE = 0.6; // the winner must cover ≥60% of what was said
export const STREAK = 2; // …in 2 consecutive segments
export const MIN_SWITCH_GAP_MS = 20_000; // and never flip faster than every 20 s

export interface RoomSample {
  lang: string;
  weight: number;
  t: number;
}

export interface RoomState {
  samples: RoomSample[];
  /** Language others hear me in; null = my own voice. */
  current: string | null;
  candidate: string | null;
  streak: number;
  /** When `current` last changed (0 = never). */
  switchedAt: number;
}

export function emptyRoom(): RoomState {
  return { samples: [], current: null, candidate: null, streak: 0, switchedAt: 0 };
}

function base(code: string | null | undefined): string {
  return (code || "").split("-")[0].trim().toLowerCase();
}

/** Language with the most speech in the window and its share of all speech. */
export function dominant(samples: RoomSample[]): { lang: string | null; share: number } {
  const weights = new Map<string, number>();
  let total = 0;
  for (const s of samples) {
    weights.set(s.lang, (weights.get(s.lang) ?? 0) + s.weight);
    total += s.weight;
  }
  let lang: string | null = null;
  let best = 0;
  for (const [l, w] of weights) {
    if (w > best) {
      best = w;
      lang = l;
    }
  }
  return { lang, share: total > 0 ? best / total : 0 };
}

/**
 * Add one finalized segment said by someone else. `myLang` is the language I
 * speak: when it dominates, the room needs no translation of my voice (null).
 */
export function observeRoom(
  state: RoomState,
  segment: { lang: string | null | undefined; text: string; t: number },
  myLang: string
): RoomState {
  const lang = base(segment.lang);
  const chars = segment.text.trim().length;
  const samples = state.samples.filter((s) => segment.t - s.t <= ROOM_WINDOW_MS);
  if (!lang || chars < MIN_SEGMENT_CHARS) return { ...state, samples };
  samples.push({ lang, weight: chars, t: segment.t });

  const { lang: winner, share } = dominant(samples);
  if (!winner || share < MIN_SHARE) return { ...state, samples, candidate: null, streak: 0 };

  const wanted = winner === base(myLang) ? null : winner;
  if (wanted === state.current) return { ...state, samples, candidate: null, streak: 0 };

  const streak = state.candidate === wanted ? state.streak + 1 : 1;
  const firstPick = state.switchedAt === 0 && state.current === null;
  const gapOk = firstPick || segment.t - state.switchedAt >= MIN_SWITCH_GAP_MS;
  if (streak >= STREAK && gapOk) {
    return { samples, current: wanted, candidate: null, streak: 0, switchedAt: segment.t };
  }
  return { ...state, samples, candidate: wanted, streak };
}
