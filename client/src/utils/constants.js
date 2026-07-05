// ─────────────────────────────────────────────────────────────────────────
// constants.js — shared, tweak-in-one-place configuration values.
// ─────────────────────────────────────────────────────────────────────────

// How often each part of the UI polls the backend (milliseconds).
export const POLL_INTERVALS = {
  live: 1000, // live cards + charts: once per second
  stats: 5000,
  health: 5000,
  history: 5000,
};

// How many recent points each live chart keeps on screen.
export const CHART_WINDOW = 30;

// If the newest stored reading is fresher than this many seconds, we assume
// Node-RED is actively sending data (so its status indicator shows "online").
export const NODE_RED_FRESH_SECONDS = 5;

// Definition of the numeric sensor cards. `min`/`max` drive the little
// fill-bar under each value; `accent` maps to a CSS colour class.
export const SENSORS = [
  { key: 'flowRate',          label: 'Flow Rate',          unit: 'L/min', min: 50,  max: 300,  accent: 'flow' },
  { key: 'rpm',               label: 'RPM',                unit: 'rpm',   min: 1000, max: 3600, accent: 'rpm' },
  { key: 'vibration',         label: 'Vibration',          unit: 'mm/s',  min: 0.5, max: 12,   accent: 'vibration' },
  { key: 'suctionPressure',   label: 'Suction Pressure',   unit: 'bar',   min: 0.5, max: 3,    accent: 'pressure' },
  { key: 'dischargePressure', label: 'Discharge Pressure', unit: 'bar',   min: 2,   max: 12,   accent: 'pressure' },
  { key: 'motorTemp',         label: 'Motor Temp',         unit: '°C',    min: 20,  max: 90,   accent: 'temp' },
];
