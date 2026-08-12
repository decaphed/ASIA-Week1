import { useEffect, useMemo, useState } from 'react';
import Card, { CardLabel, Pill, buttonReset } from '../components/Card.jsx';
import ProcessSchematic from '../components/ProcessSchematic.jsx';
import { METRICS, SC, THRESHOLDS, statusOf, isExcursion, fmt } from '../utils/constants.js';
import { pts, line, area, arc, polar, range } from '../utils/geometry.js';
import { ageOf } from '../utils/faultEvents.js';

function HealthGauge({ health, statuses, unknown }) {
  const color = unknown ? SC.unknown : health >= 90 ? SC.ok : health >= 55 ? SC.warn : SC.crit;
  const label = unknown
    ? 'No data'
    : health >= 90 ? 'Healthy' : health >= 70 ? 'Acceptable' : health >= 50 ? 'Degraded' : 'Unacceptable';
  // With no live reading there is no meaningful needle position — park it at
  // the start of the scale rather than implying a score.
  const ga = unknown ? -120 : -120 + (240 * health) / 100;
  const dot = polar(115, 96, 82, ga);
  const ticks = [];
  for (let i = 0; i <= 10; i++) {
    const a = -120 + i * 24;
    ticks.push({ p0: polar(115, 96, 66, a), p1: polar(115, 96, i % 5 === 0 ? 58 : 61, a), major: i % 5 === 0 });
  }
  const critList = METRICS.filter((m) => statuses[m.key] === 'crit').map((m) => m.label);
  const warnList = METRICS.filter((m) => statuses[m.key] === 'warn').map((m) => m.label);
  const note = unknown
    ? 'No current reading from the gateway, so machine health cannot be scored. The figures below are not live.'
    : critList.length || warnList.length
      ? 'Driven down by ' + [...critList.map((x) => `${x} (alarm)`), ...warnList.map((x) => `${x} (warning)`)].join(' and ') + '. Combined score across all 6 monitored channels.'
      : 'All 6 channels within normal operating limits.';

  return (
    <Card>
      <CardLabel>Machine Health</CardLabel>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 0' }}>
        <svg width="230" height="168" viewBox="0 0 230 168" role="img" aria-label={`Machine health: ${unknown ? 'no data' : `${health} out of 100, ${label}`}`}>
          <path d={arc(115, 96, 82, -120, 0)} stroke="#F2D7D4" strokeWidth="12" fill="none" strokeLinecap="round" />
          <path d={arc(115, 96, 82, 0, 84)} stroke="#F1E4C4" strokeWidth="12" fill="none" />
          <path d={arc(115, 96, 82, 84, 120)} stroke="#CFE8DA" strokeWidth="12" fill="none" strokeLinecap="round" />
          {ticks.map((t, i) => (
            <line key={i} x1={t.p0[0]} y1={t.p0[1]} x2={t.p1[0]} y2={t.p1[1]} stroke={t.major ? '#9fb0bf' : '#d3dbe2'} strokeWidth={t.major ? 1.6 : 1} />
          ))}
          {!unknown && (
            <>
              <path d={arc(115, 96, 82, -120, ga)} stroke={color.c} strokeWidth="12" fill="none" strokeLinecap="round" style={{ transition: 'stroke .8s ease' }} />
              <circle cx={dot[0].toFixed(1)} cy={dot[1].toFixed(1)} r="8" fill="#ffffff" stroke={color.c} strokeWidth="3.5" />
            </>
          )}
          <text x="115" y="106" textAnchor="middle" style={{ fontFamily: "'IBM Plex Sans'", fontSize: 44, fontWeight: 600, fill: unknown ? '#8a99a8' : '#1a2530', fontVariantNumeric: 'tabular-nums' }}>
            {unknown ? '—' : health}
          </text>
          <text x="115" y="126" textAnchor="middle" style={{ fontFamily: "'IBM Plex Sans'", fontSize: 12, fill: '#8a99a8' }}>/ 100</text>
          <text x="28" y="152" textAnchor="middle" style={{ fontFamily: "'IBM Plex Sans'", fontSize: 10, fill: '#a7b3bf' }}>0</text>
          <text x="202" y="152" textAnchor="middle" style={{ fontFamily: "'IBM Plex Sans'", fontSize: 10, fill: '#a7b3bf' }}>100</text>
        </svg>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 2 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, borderRadius: 99, padding: '5px 14px', fontSize: 12.5, fontWeight: 600, background: color.bg, color: color.c, border: `1px solid ${color.bd}` }}>
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: color.c }} />{label}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
        {METRICS.map((m) => {
          const sc = SC[statuses[m.key]] || SC.unknown;
          return (
            <span key={m.key} title={`${m.label}: ${sc.label}`} style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', borderRadius: 4, padding: '3px 7px', fontFamily: "'IBM Plex Mono',monospace", background: sc.bg, color: sc.c }}>
              {m.short}
              <span className="sr-only"> {sc.label}</span>
            </span>
          );
        })}
      </div>
      <p style={{ margin: 0, marginTop: 14, paddingTop: 12, borderTop: '1px solid #eef2f5', fontSize: 12, color: '#5f6f7e', lineHeight: 1.55 }}>{note}</p>
    </Card>
  );
}

const ALARM_TAGS = {
  flowRate: 'FT-101', rpm: 'P-101', vibration: 'VT-101',
  suctionPressure: 'PT-101', dischargePressure: 'PT-102', motorTemp: 'TT-101',
};

function alarmLimitOf(key, status) {
  const t = THRESHOLDS[key];
  if (status === 'crit') return t.alarmHigh ?? t.alarmLow;
  return t.warnHigh ?? t.warnLow;
}

function AlarmsPanel({ reading, statuses, alarmStarts, stale }) {
  const rows = METRICS.filter((m) => isExcursion(statuses[m.key])).map((m) => {
    const st = statuses[m.key];
    const sc = SC[st];
    const limit = alarmLimitOf(m.key, st);
    return {
      key: m.key,
      title: `${m.label} ${st === 'crit' ? 'above the alarm limit' : 'past the warning level'}`,
      detail: `${ALARM_TAGS[m.key]} · ${fmt(reading?.[m.key], m.dec)} ${m.unit} vs ${fmt(limit, m.dec)} ${st === 'crit' ? 'alarm' : 'warning'} limit`,
      sev: st === 'crit' ? 'CRITICAL' : 'WARNING',
      color: sc.c,
      bg: sc.bg,
      time: alarmStarts[m.key] ? new Date(alarmStarts[m.key]).toTimeString().slice(0, 8) : '—',
    };
  });

  if (stale) {
    // Never claim "no active alarms" when there is nothing to judge alarms
    // against — an outage must not read as an all-clear.
    rows.unshift({
      key: 'stale',
      title: 'Alarm state unknown — no live readings',
      detail: 'The gateway feed has stopped, so channels cannot be evaluated against their limits.',
      sev: 'NO DATA',
      color: SC.unknown.c,
      bg: SC.unknown.bg,
      time: '—',
    });
  } else if (!rows.length) {
    rows.push({ key: 'none', title: 'No active alarms', detail: 'All channels within limits', sev: 'OK', color: '#177E4D', bg: '#E4F3EB', time: '—' });
  }

  const activeCount = rows.filter((r) => r.sev === 'CRITICAL' || r.sev === 'WARNING').length;

  return (
    <Card style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <CardLabel>Active Alarms</CardLabel>
        <span style={{ fontSize: 11.5, color: '#8a99a8', fontVariantNumeric: 'tabular-nums' }}>{activeCount} active</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
        {rows.map((al) => (
          <div key={al.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 2px', borderTop: '1px solid #eef2f5' }}>
            <span aria-hidden="true" style={{ marginTop: 4, width: 8, height: 8, borderRadius: 2, background: al.color, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: '#1a2530' }}>{al.title}</div>
              <div style={{ fontSize: 12, color: '#5f6f7e', marginTop: 2 }}>{al.detail}</div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <span style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.05em', borderRadius: 4, padding: '2px 7px', background: al.bg, color: al.color }}>{al.sev}</span>
              <div style={{ fontSize: 11.5, color: '#8a99a8', marginTop: 4, fontFamily: "'IBM Plex Mono',monospace" }}>{al.time}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 'auto', paddingTop: 10, borderTop: '1px solid #eef2f5', fontSize: 12, color: '#8a99a8' }}>
        Alarm limits follow the warn/alarm bands configured for this pump class
      </div>
    </Card>
  );
}

function QueueCard({ queue, goReview }) {
  const critical = queue.filter((q) => String(q.confidence).toUpperCase() === 'HIGH').length;
  const oldest = queue.length
    ? ageOf(queue.reduce((a, b) => (Date.parse(a.detectedAt) < Date.parse(b.detectedAt) ? a : b)).detectedAt)
    : '—';
  return (
    <Card style={{ display: 'flex', flexDirection: 'column' }}>
      <CardLabel>Fault Review Queue</CardLabel>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 12 }}>
        <span style={{ fontSize: 38, fontWeight: 600, fontVariantNumeric: 'tabular-nums', lineHeight: 1, color: '#1a2530' }}>{queue.length}</span>
        <span style={{ fontSize: 13, color: '#5f6f7e' }}>pending review</span>
      </div>
      <p style={{ margin: 0, fontSize: 12.5, color: '#5f6f7e', lineHeight: 1.55, marginTop: 10 }}>
        New detections wait here until an engineer signs off on them.
      </p>
      <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 99, padding: '3px 9px', background: '#FBF3E0', color: '#8a5f00', border: '1px solid #ecd9a8' }}>{critical} critical</span>
        <span style={{ fontSize: 11, fontWeight: 600, borderRadius: 99, padding: '3px 9px', background: '#eef1f4', color: '#5f6f7e', border: '1px solid #dde4ea' }}>oldest {oldest}</span>
      </div>
      <button
        type="button"
        className="hover-primary"
        onClick={goReview}
        style={{ ...buttonReset, marginTop: 'auto', background: '#1F3A6E', color: '#ffffff', borderRadius: 6, padding: '9px 12px', textAlign: 'center', fontSize: 13, fontWeight: 600, boxShadow: '0 1px 2px rgba(22,41,79,0.3)' }}
      >
        Open review queue
      </button>
    </Card>
  );
}

function MetricCard({ metric, buffer, reading, stale }) {
  const value = reading?.[metric.key];
  const st = statusOf(metric.key, value);
  const sc = SC[st];
  const arr = buffer.length ? buffer : [0];
  const [mn, mx] = range(arr);
  const p = pts(arr, 2, 4, 236, 36, mn, mx);
  const delta = arr.length > 1 ? arr[arr.length - 1] - arr[0] : 0;
  // A frozen trace is not a flat trend — grey it out rather than implying the
  // last minute of history is current.
  const traceColor = stale ? SC.unknown.c : sc.c;
  return (
    <Card style={{ padding: '18px 20px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: '#5f6f7e' }}>{metric.label}</h3>
        <Pill color={sc.c} bg={sc.bg} style={{ padding: '2px 9px' }}>{sc.label}</Pill>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 8 }}>
        <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums', color: st === 'unknown' ? '#8a99a8' : '#1a2530' }}>
          {fmt(value, metric.dec)}
        </span>
        <span style={{ fontSize: 13, color: '#8a99a8', fontWeight: 500 }}>{metric.unit}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: st === 'ok' || st === 'unknown' ? '#8a99a8' : sc.c }}>
          {stale ? 'no feed' : `${delta >= 0 ? '+' : '−'}${fmt(Math.abs(delta), metric.dec)} /min`}
        </span>
      </div>
      <svg width="100%" height="44" viewBox="0 0 240 44" preserveAspectRatio="none" style={{ marginTop: 8, display: 'block' }} aria-hidden="true">
        <path d={area(p, 42)} fill={traceColor} opacity="0.10" />
        <path d={line(p)} stroke={traceColor} strokeWidth="1.8" fill="none" strokeLinejoin="round" />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: '#a7b3bf', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
        <span>−60 s</span><span>{stale ? 'stale' : 'now'}</span>
      </div>
    </Card>
  );
}

export default function OverviewPage({ live, queue, goReview }) {
  const { latest, buffers, stale, lastUpdatedAt } = live;

  // The most important line on this page: when the feed is stale there is NO
  // current reading, so nothing downstream may present the last-known values
  // as live. statusOf() then yields 'unknown' rather than 'ok'.
  const reading = stale ? null : latest;

  const statuses = useMemo(() => {
    const s = {};
    for (const m of METRICS) s[m.key] = statusOf(m.key, reading?.[m.key]);
    return s;
  }, [reading]);

  // Alarm start times are real state, not a ref read during render:
  // /api/live exposes current values only, never alarm history.
  const [alarmStarts, setAlarmStarts] = useState({});
  useEffect(() => {
    if (!reading) {
      setAlarmStarts((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    setAlarmStarts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const m of METRICS) {
        if (!isExcursion(statuses[m.key])) {
          if (next[m.key]) { delete next[m.key]; changed = true; }
        } else if (!next[m.key]) {
          next[m.key] = reading.timestamp;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [statuses, reading]);

  const health = useMemo(() => {
    let h = 100;
    for (const m of METRICS) {
      if (statuses[m.key] === 'crit') h -= 25;
      else if (statuses[m.key] === 'warn') h -= 10;
    }
    return Math.max(5, h);
  }, [statuses]);

  return (
    <div style={{ padding: '26px 32px 44px', display: 'flex', flexDirection: 'column', gap: 20, animation: 'fadeUp .3s ease' }}>
      {stale && (
        <div
          role="alert"
          style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#FBEAE8', border: '1px solid #efc4bf', borderRadius: 8, padding: '12px 16px' }}
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
            <path d="M8 1.8 L15 13.8 L1 13.8 Z" stroke="#B3282D" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M8 6.5 L8 9.8" stroke="#B3282D" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="8" cy="11.9" r="0.9" fill="#B3282D" />
          </svg>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: '#B3282D' }}>No live data from the gateway</div>
            <div style={{ fontSize: 12.5, color: '#8a3b38', marginTop: 2 }}>
              Readings below are not current and alarm state cannot be evaluated.
              {lastUpdatedAt ? ` Last reading received at ${new Date(lastUpdatedAt).toTimeString().slice(0, 8)}.` : ' No reading has been received yet.'}
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr 300px', gap: 20 }}>
        <HealthGauge health={health} statuses={statuses} unknown={stale} />
        <AlarmsPanel reading={reading} statuses={statuses} alarmStarts={alarmStarts} stale={stale} />
        <QueueCard queue={queue} goReview={goReview} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 20 }}>
        {METRICS.map((m) => (
          <MetricCard key={m.key} metric={m} buffer={buffers[m.key]} reading={reading} stale={stale} />
        ))}
      </div>
      <ProcessSchematic reading={reading} statuses={statuses} stale={stale} />
    </div>
  );
}
