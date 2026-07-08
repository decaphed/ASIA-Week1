// ─────────────────────────────────────────────────────────────────────────
// Icons.jsx — industrial pump monitoring icon set.
// v3: purpose-built SVGs for each pump metric and UI element.
//     All icons: 24×24 viewBox, stroke="currentColor", no fill.
// ─────────────────────────────────────────────────────────────────────────

const base = {
  viewBox: '0 0 24 24',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

// ── Pump / hydraulic icons ─────────────────────────────────────────────────

// Flow rate — fluid moving through a pipe with directional arrows
export function FlowIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M5 12h14" />
      <path d="M15 8l4 4-4 4" />
      <path d="M3 6c0 0 2-2 4-2s4 2 4 2 2 2 4 2 4-2 4-2" />
    </svg>
  );
}

// Shaft speed / RPM — rotating impeller/gear
export function RpmIcon(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" />
    </svg>
  );
}

// Vibration — waveform oscillation
export function VibrationIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M2 12h3l2.5-7 4 14 3-10 2 3H22" />
    </svg>
  );
}

// Pressure gauge — dial with needle
export function GaugeIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z" strokeWidth="1.5" />
      <path d="M12 12 8.5 8.5" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <path d="M7 17h10" strokeWidth="1" opacity="0.4" />
      <path d="M12 7v1.5" strokeWidth="1.5" />
      <path d="M17 12h-1.5" strokeWidth="1.5" />
      <path d="M7 12h1.5" strokeWidth="1.5" />
    </svg>
  );
}

// Motor temperature — thermometer inside motor outline
export function ThermometerIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M14 14.76V4a2 2 0 0 0-4 0v10.76a4 4 0 1 0 4 0Z" />
      <path d="M12 18v-6" strokeWidth="1" />
    </svg>
  );
}

// Machine status — power button
export function StatusIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 2v6" strokeWidth="2.2" />
      <path d="M8.56 4.22a9 9 0 1 0 6.88 0" />
    </svg>
  );
}

// Alarm / alert bell
export function AlarmIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

// Warning triangle
export function WarnIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" strokeWidth="2.5" />
    </svg>
  );
}

// Fault / X in circle
export function FaultIcon(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

// Check / OK — circle with checkmark
export function CheckIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="M22 4 12 14.01l-3-3" />
    </svg>
  );
}

// Info — circle with "i"
export function InfoIcon(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" strokeWidth="2.4" />
    </svg>
  );
}

// Sidebar nav icons ──────────────────────────────────────────────────────────

export function DashboardNavIcon(props) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

export function SensorsNavIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

export function HistoryNavIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 5 6.5L3 3" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

export function AnalyticsNavIcon(props) {
  return (
    <svg {...base} {...props}>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

export function SettingsNavIcon(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

// Theme toggle icons ─────────────────────────────────────────────────────────

export function SunIcon(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

export function MoonIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

// Reports / documents nav icon
export function ReportsNavIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h8M8 9h2" />
    </svg>
  );
}

// Keep legacy exports used by older code paths
export const DropletIcon = FlowIcon;
export const BulbIcon    = StatusIcon;

// Crystal-ball-style spark icon for the AI Predictions nav entry.
export function PredictNavIcon(props) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3a7 7 0 0 1 7 7c0 2.4-1.2 4.5-3 5.7V19a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-3.3c-1.8-1.2-3-3.3-3-5.7a7 7 0 0 1 7-7z" />
      <path d="M9.5 21h5" />
      <path d="M12 7v3l2 2" />
    </svg>
  );
}
