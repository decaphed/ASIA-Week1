// ─────────────────────────────────────────────────────────────────────────
// Icons.jsx — monochrome SVG icon set for sensor cards and navigation.
// v2: unified 16×16 viewport, stroke="currentColor", consistent weight.
// ─────────────────────────────────────────────────────────────────────────

const base = {
  viewBox: '0 0 24 24',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

// ── Sensor card icons ──────────────────────────────────────────────────────

export function ThermometerIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0Z" />
    </svg>
  );
}

export function DropletIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 2s6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 6-11 6-11Z" />
    </svg>
  );
}

export function GaugeIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4.5 16.5a8 8 0 1 1 15 0" />
      <path d="M12 16.5 15.2 11" />
      <circle cx="12" cy="16.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function BulbIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.2 11.1c.5.3.7.9.7 1.5V16h5v-.4c0-.6.2-1.2.7-1.5A6 6 0 0 0 12 3Z" />
    </svg>
  );
}

export function FlowIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />
    </svg>
  );
}

export function RpmIcon(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 12 16.5 7.5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function VibrationIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M2 12h2.5l2-7 4 14 4-14 2 7H22" />
    </svg>
  );
}

export function StatusIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}
