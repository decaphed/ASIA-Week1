// ─────────────────────────────────────────────────────────────────────────
// usePolling.js — the ONE custom hook that powers all live updates.
//
// It repeatedly calls an async `fetcher` on a timer and exposes {data, error,
// loading, refresh}. Every data hook (useLiveData, useStats, …) is a thin
// wrapper around this, so the "poll → setState → re-render" logic lives in a
// single, well-tested place.
//
// Key React ideas demonstrated here:
//   • useState      — holds the latest data/error/loading so React re-renders.
//   • useEffect     — starts the interval on mount, and its cleanup function
//                     clears the interval on unmount (no leaks, safe under
//                     React StrictMode's double-invoke).
//   • useRef        — stores the newest fetcher without restarting the timer.
//   • Graceful fail — on error we keep the PREVIOUS data on screen and just
//                     surface the error, so a brief network blip doesn't blank
//                     the dashboard.
//
// Options:
//   • key     — identifies WHAT is being fetched (e.g. the selected time
//               range). Changing it restarts the poll, refetches immediately,
//               and invalidates any response still in flight for the old key,
//               so a slow stale response can never overwrite fresher data.
//   • enabled — false pauses the poll entirely (no timer, no fetch); flipping
//               back to true restarts it with an immediate fetch.
// ─────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react';

export function usePolling(fetcher, intervalMs, { immediate = true, key = null, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(immediate && enabled);

  // Keep the latest fetcher in a ref. Components pass a fresh arrow function
  // each render; storing it in a ref lets us use the newest one WITHOUT
  // tearing down and recreating the interval every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Generation counter — bumped by the effect's cleanup (key change, disable,
  // or unmount). A tick captures the generation when it starts and only
  // commits its result if it is still current, so out-of-order responses are
  // dropped instead of repainting the screen with data for the wrong key.
  // This also makes the hook safe under StrictMode's effect double-invoke.
  const genRef = useRef(0);

  const tick = useCallback(async () => {
    const gen = genRef.current;
    try {
      const result = await fetcherRef.current();
      if (gen !== genRef.current) return; // stale: key changed / unmounted mid-flight
      setData(result);
      setError(null);
    } catch (err) {
      if (gen !== genRef.current) return;
      // Keep old `data` visible; just record the error.
      setError(err);
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    if (immediate) {
      setLoading(true); // a key change is a new query — surface it as loading
      tick();           // fetch right away so we don't wait a full interval
    }
    const id = setInterval(tick, intervalMs);
    return () => {
      genRef.current += 1; // invalidate any fetch still in flight
      clearInterval(id);
    };
  }, [tick, intervalMs, immediate, key, enabled]);

  return { data, error, loading, refresh: tick };
}
