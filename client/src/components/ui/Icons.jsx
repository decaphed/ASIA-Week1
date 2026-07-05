// ─────────────────────────────────────────────────────────────────────────
// Icons.jsx — small monochrome line icons for the sensor cards.
//
// Plain SVG with stroke="currentColor" rather than emoji characters, so they
// render as consistent single-color glyphs matching the dark industrial
// theme instead of platform-specific colorful emoji.
// ─────────────────────────────────────────────────────────────────────────

const base = {
  viewBox: '0 0 24 24',
  width: 18,
  height: 18,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

export function ThermometerIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0Z" />
      <circle cx="12" cy="18" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DropletIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3s6 6.7 6 10.5A6 6 0 1 1 6 13.5C6 9.7 12 3 12 3Z" />
    </svg>
  );
}

export function GaugeIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 15a8 8 0 1 1 16 0" />
      <path d="M12 15 15.5 10" />
      <circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function BulbIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.2 11.1c.5.3.7.9.7 1.5V16h5v-.4c0-.6.2-1.2.7-1.5A6 6 0 0 0 12 3Z" />
    </svg>
  );
}

export function FlowIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12h4l3-7 4 14 3-7h4" />
    </svg>
  );
}

export function RpmIcon(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 12 16 8" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function VibrationIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M2 12h2l2-5 4 10 4-10 2 5h6" />
    </svg>
  );
}

export function StatusIcon(props) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M9 12h6" />
      <path d="M12 9v6" />
    </svg>
  );
}
