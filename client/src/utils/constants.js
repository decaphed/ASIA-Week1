// ─────────────────────────────────────────────────────────────────────────
// constants.js — shared configuration values.
// ─────────────────────────────────────────────────────────────────────────

export const POLL_INTERVALS = {
  live:      1000,
  stats:     5000,
  health:    5000,
  history:   5000,
  forecast:  15000,
  drift:     15000,
  trend:     15000,
  processed: 15000,
  series:    60000,
  summary:   60000,
};

// Above this fraction of a window's samples being reconstructed (not
// measured), SystemHealthPanel's "Data Reliability" row switches from a
// quiet "Live" state to flagging the estimate — occasional single-tick
// gap-fills shouldn't trigger a constant warning.
export const IMPUTATION_WARN_THRESHOLD = 0.1;

export const CHART_WINDOW = 40;

export const NODE_RED_FRESH_SECONDS = 5;

// ── Pump identity ─────────────────────────────────────────────────────────
export const PUMP_ID   = 'PUMP-01';
export const PUMP_NAME = 'Centrifugal Pump Unit 1';
export const PUMP_AREA = 'Process Line A — Bay 3';

// ── Sensor definitions ────────────────────────────────────────────────────
// `min`/`max`  → fill-bar operating range (normal envelope)
// `warnHigh`   → value above which we show a WARNING state (amber)
// `alarmHigh`  → value above which we show an ALARM state (red)
// `warnLow`    → value below which we show a WARNING state
// `alarmLow`   → value below which we show an ALARM state
// `accent`     → CSS colour class
export const SENSORS = [
  {
    key:       'flowRate',
    label:     'Flow Rate',
    shortLabel:'FLOW',
    unit:      'L/min',
    min:       50,   max:       300,
    warnLow:   80,   alarmLow:  60,
    warnHigh:  270,  alarmHigh: 295,
    accent:    'flow',
    prec:      1,
    desc:      'Volumetric flow through pump',
  },
  {
    key:       'rpm',
    label:     'Shaft Speed',
    shortLabel:'RPM',
    unit:      'rpm',
    min:       1000, max:       3600,
    warnLow:   1200, alarmLow:  1050,
    warnHigh:  3400, alarmHigh: 3550,
    accent:    'rpm',
    prec:      0,
    desc:      'Impeller rotational speed',
  },
  {
    key:       'vibration',
    label:     'Vibration',
    shortLabel:'VIB',
    unit:      'mm/s',
    min:       0.5,  max:       12,
    warnLow:   null, alarmLow:  null,
    warnHigh:  7.1,  alarmHigh: 11.2,
    accent:    'vibration',
    prec:      2,
    desc:      'RMS vibration velocity (ISO 10816)',
  },
  {
    key:       'suctionPressure',
    label:     'Suction Pressure',
    shortLabel:'SUCT',
    unit:      'bar',
    min:       0.5,  max:       3,
    warnLow:   0.8,  alarmLow:  0.6,
    warnHigh:  2.8,  alarmHigh: 2.95,
    accent:    'pressure-s',
    prec:      2,
    desc:      'Pump inlet pressure',
  },
  {
    key:       'dischargePressure',
    label:     'Discharge Pressure',
    shortLabel:'DISCH',
    unit:      'bar',
    min:       2,    max:       12,
    warnLow:   3,    alarmLow:  2.2,
    warnHigh:  10.5, alarmHigh: 11.5,
    accent:    'pressure-d',
    prec:      2,
    desc:      'Pump outlet pressure',
  },
  {
    key:       'motorTemp',
    label:     'Motor Temp',
    shortLabel:'TEMP',
    unit:      '°C',
    min:       20,   max:       90,
    warnLow:   null, alarmLow:  null,
    warnHigh:  75,   alarmHigh: 85,
    accent:    'temp',
    prec:      1,
    desc:      'Motor winding temperature',
  },
];

// ── Alarm evaluation helper ───────────────────────────────────────────────
// Returns 'alarm' | 'warn' | 'normal' | 'nodata'
export function getAlarmState(sensor, value) {
  if (value === null || value === undefined) return 'nodata';
  if (sensor.alarmHigh !== null && value >= sensor.alarmHigh) return 'alarm';
  if (sensor.alarmLow  !== null && value <= sensor.alarmLow)  return 'alarm';
  if (sensor.warnHigh  !== null && value >= sensor.warnHigh)  return 'warn';
  if (sensor.warnLow   !== null && value <= sensor.warnLow)   return 'warn';
  return 'normal';
}
