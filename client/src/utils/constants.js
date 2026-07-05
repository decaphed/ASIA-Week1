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
  { key: 'temperature', label: 'Temperature', unit: '°C', min: 20, max: 35, accent: 'temp' },
  { key: 'humidity', label: 'Humidity', unit: '%', min: 40, max: 80, accent: 'humidity' },
  { key: 'pressure', label: 'Pressure', unit: 'hPa', min: 980, max: 1040, accent: 'pressure' },
];
