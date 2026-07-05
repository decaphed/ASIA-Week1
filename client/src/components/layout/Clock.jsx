// ─────────────────────────────────────────────────────────────────────────
// Clock.jsx — a live wall clock in the top bar.
//
// A tiny example of the same pattern the whole app uses: setInterval inside a
// useEffect, cleared on unmount. Updates once per second.
// ─────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';

export default function Clock() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="clock">
      <span className="clock__time">{now.toLocaleTimeString()}</span>
      <span className="clock__date">
        {now.toLocaleDateString(undefined, {
          weekday: 'short',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })}
      </span>
    </div>
  );
}
