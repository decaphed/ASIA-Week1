// ─────────────────────────────────────────────────────────────────────────
// useAsync.js — fetch-once-on-mount (not polling), with a manual `refresh`.
// Mirrors usePolling.js's generation-counter stale-response guard, but has
// no interval: usePolling always sets up a timer, and there's no clean way
// to express "just once" through it.
// ─────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react';

export function useAsync(fetcher, key) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const genRef = useRef(0);

  const run = useCallback(async () => {
    const gen = genRef.current;
    setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (gen !== genRef.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (gen !== genRef.current) return;
      setError(err);
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    run();
    return () => {
      genRef.current += 1; // invalidate any fetch still in flight (key change / unmount)
    };
  }, [run, key]);

  // Lets a caller write a value straight into state (e.g. a PATCH response)
  // without an extra round-trip GET.
  const setDataDirect = useCallback((value) => setData(value), []);

  return { data, error, loading, refresh: run, setData: setDataDirect };
}
