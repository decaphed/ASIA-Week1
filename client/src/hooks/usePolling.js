import { useCallback, useEffect, useRef, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────
// usePolling — call an async fetcher on an interval, keeping the last good
// value when a poll fails so a transient network blip doesn't blank the UI.
// `deps` re-arms the loop (e.g. when the selected range changes).
// ─────────────────────────────────────────────────────────────────────────
export function usePolling(fetcher, intervalMs, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const tick = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      if (!alive.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (!alive.current) return;
      setError(err);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    tick();
    const t = intervalMs ? setInterval(tick, intervalMs) : null;
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
    // exhaustive-deps is disabled deliberately, for two reasons:
    //   • `deps` is a caller-supplied array spread into the dependency list,
    //     which the rule cannot verify statically.
    //   • `fetcher` is intentionally NOT a dependency — it is almost always a
    //     fresh arrow function per render, so depending on it would re-arm the
    //     interval on every render. It is read through fetcherRef instead, so
    //     each tick still calls the latest closure and never reads stale state.
    // `intervalMs` IS listed, so changing the cadence re-arms the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);

  return { data, error, loading, refresh: tick };
}
