import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { METRICS } from '../utils/constants.js';

const BUFFER_LEN = 60; // one minute of 1 Hz readings, matching the spark cards

// A reading older than this many poll intervals counts as stale: the gateway
// can still be answering while no longer producing fresh samples.
const STALE_INTERVALS = 3;

const emptyBuffers = () => Object.fromEntries(METRICS.map((m) => [m.key, []]));

// ─────────────────────────────────────────────────────────────────────────
// useLiveBuffer — polls GET /api/live and keeps a rolling 60-sample buffer
// per metric, driving the Overview cards, sparklines and schematic.
//
// Staleness is first-class. A failed poll previously left `latest` in place
// indefinitely, so an outage rendered as a healthy pump showing
// current-looking numbers. Callers must treat `stale === true` as "no
// current reading" rather than displaying the last value as live.
//
// Buffers are replaced, not mutated, on each tick: a caller memoising on the
// array identity (or a React.memo'd chart) would otherwise never observe new
// samples even though the contents changed.
// ─────────────────────────────────────────────────────────────────────────
export function useLiveBuffer(intervalMs = 1000) {
  const [latest, setLatest] = useState(null);
  const [connected, setConnected] = useState(false);
  const [stale, setStale] = useState(true);
  const [buffers, setBuffers] = useState(emptyBuffers);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  const lastStampRef = useRef(null);
  const lastUpdateMsRef = useRef(null);

  useEffect(() => {
    let alive = true;
    const staleAfter = intervalMs * STALE_INTERVALS;

    const markStaleIfOverdue = () => {
      const since = lastUpdateMsRef.current;
      if (since == null || Date.now() - since > staleAfter) setStale(true);
    };

    async function poll() {
      try {
        const { data } = await api.live();
        if (!alive) return;
        setConnected(true);

        if (data && data.timestamp !== lastStampRef.current) {
          lastStampRef.current = data.timestamp;
          lastUpdateMsRef.current = Date.now();
          setBuffers((prev) => {
            const next = {};
            for (const m of METRICS) {
              const grown = [...prev[m.key], data[m.key]];
              next[m.key] = grown.length > BUFFER_LEN ? grown.slice(grown.length - BUFFER_LEN) : grown;
            }
            return next;
          });
          setLatest(data);
          setLastUpdatedAt(lastUpdateMsRef.current);
          setStale(false);
        } else {
          // Reachable but not producing new samples — still a stale feed.
          markStaleIfOverdue();
        }
      } catch {
        if (!alive) return;
        setConnected(false);
        markStaleIfOverdue();
      }
    }

    poll();
    const t = setInterval(poll, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);

  return { latest, buffers, connected, stale, lastUpdatedAt };
}
