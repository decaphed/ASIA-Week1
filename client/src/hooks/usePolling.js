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
// ─────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react';

export function usePolling(fetcher, intervalMs, { immediate = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(immediate);

  // Keep the latest fetcher in a ref. Components pass a fresh arrow function
  // each render; storing it in a ref lets us use the newest one WITHOUT
  // tearing down and recreating the interval every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const tick = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      // Keep old `data` visible; just record the error.
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (immediate) tick(); // fetch once right away so we don't wait a full interval
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id); // cleanup on unmount / interval change
  }, [tick, intervalMs, immediate]);

  return { data, error, loading, refresh: tick };
}
