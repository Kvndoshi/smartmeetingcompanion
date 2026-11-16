// React hooks shared by the popup and the side panel.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ext } from "./ext";
import type { SessionState } from "./protocol";

/** Live service-worker session state (initial fetch + "state" broadcasts). */
export function useSessionState(): SessionState | null {
  const [state, setState] = useState<SessionState | null>(null);
  useEffect(() => {
    let alive = true;
    void ext.getState().then((s) => {
      if (alive && s) setState(s);
    });
    const off = ext.onUiMessage((msg) => {
      if (msg.type === "state") setState(msg.state);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

/** Seconds since `startedAt`, ticking once a second while `active`. */
export function useElapsed(startedAt: number | null | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);
  return active && startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type Theme = "light" | "dark";

/** Theme shared across extension pages via storage (defaults to the OS preference). */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  );
  useEffect(() => {
    void ext.storageGet<{ theme: Theme }>(["theme"]).then((d) => {
      if (d.theme === "light" || d.theme === "dark") setTheme(d.theme);
    });
  }, []);
  useEffect(() => {
    document.body.classList.toggle("theme-dark", theme === "dark");
  }, [theme]);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      ext.storageSet({ theme: next });
      return next;
    });
  }, []);
  return [theme, toggle];
}

/** Backend reachability: null while checking, then true/false. */
export function useBackendHealth(): { online: boolean | null; recheck: () => void } {
  const [online, setOnline] = useState<boolean | null>(null);
  const seq = useRef(0);
  const recheck = useCallback(() => {
    const mine = ++seq.current;
    setOnline(null);
    api
      .health()
      .then(() => mine === seq.current && setOnline(true))
      .catch(() => mine === seq.current && setOnline(false));
  }, []);
  useEffect(recheck, [recheck]);
  return { online, recheck };
}

/** Debounced callback that can be flushed (e.g. before switching meetings). */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delayMs: number) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastArgs = useRef<A | null>(null);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (lastArgs.current) {
      const args = lastArgs.current;
      lastArgs.current = null;
      fnRef.current(...args);
    }
  }, []);

  const call = useCallback(
    (...args: A) => {
      lastArgs.current = args;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delayMs);
    },
    [delayMs, flush]
  );

  useEffect(() => flush, [flush]);
  return { call, flush };
}
