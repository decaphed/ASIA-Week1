import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { buttonReset } from './Card.jsx';
import { METRIC_BY_KEY, THRESHOLDS, FAULT_TYPES, fmt } from '../utils/constants.js';
import { pts, line, area, range } from '../utils/geometry.js';
import {
  eventId, eventTitle, metricsLabel, modelLine, severityOf, sevPill,
  confidenceLabel, eventMetrics, parseRules, ruleLabel, shortStamp,
  sourceLabel, sourcePill,
} from '../utils/faultEvents.js';

// ─────────────────────────────────────────────────────────────────────────
// ReviewDrawer — the HITL sign-off surface. Everything an engineer needs to
// judge one detection (evidence chart + readings around the trigger) sits
// above a form that PATCHes /api/pdm/fault-events/:id.
//
// Field requirements mirror server/utils/pdmReviewValidation.js so the
// buttons only enable for a body the server will accept.
//
// It is a real modal dialog: focus moves in on open and is restored on
// close, Tab is trapped inside, and Escape dismisses it. Without that a
// keyboard user could open this form and have no way back out.
// ─────────────────────────────────────────────────────────────────────────

const EMPTY_FORM = { faultType: '', rootCause: '', resolution: '', notes: '', faultEnd: '' };

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function EvidenceChart({ event, points }) {
  const metricKey = eventMetrics(event)[0] || 'vibration';
  const metric = METRIC_BY_KEY[metricKey];
  const th = THRESHOLDS[metricKey];

  const chart = useMemo(() => {
    const usable = points.filter((p) => p[metricKey] != null);
    if (usable.length < 2) return null;
    const values = usable.map((p) => p[metricKey]);
    let [mn, mx] = range(values, 0.2);
    if (th?.alarmHigh != null) mx = Math.max(mx, th.alarmHigh * 1.03);
    const p = pts(values, 8, 10, 404, 100, mn, mx);

    // Place the detection marker at the sample closest to the trigger window.
    const target = Date.parse(event.triggerWindowEnd || event.detectedAt);
    let markIdx = usable.length - 1;
    if (!Number.isNaN(target)) {
      let best = Infinity;
      usable.forEach((pt, i) => {
        const d = Math.abs(Date.parse(pt.t) - target);
        if (d < best) { best = d; markIdx = i; }
      });
    }
    const threshY = th?.alarmHigh != null ? 10 + 100 - ((th.alarmHigh - mn) / (mx - mn)) * 100 : null;
    return {
      linePath: line(p),
      areaPath: area(p, 110),
      mark: p[markIdx],
      threshY,
      threshVal: th?.alarmHigh != null ? fmt(th.alarmHigh, metric.dec) : '',
      readings: [
        { k: 'At detection', v: `${fmt(values[markIdx], metric.dec)} ${metric.unit}` },
        { k: '1 h before', v: `${fmt(values[Math.max(0, markIdx - 12)], metric.dec)} ${metric.unit}` },
        { k: 'Now', v: `${fmt(values[values.length - 1], metric.dec)} ${metric.unit}` },
      ],
    };
  }, [points, metricKey, metric, th, event]);

  return (
    <div>
      <h3 style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#8a99a8', marginBottom: 8 }}>
        Detection evidence · {metricsLabel(event)}
      </h3>
      <div style={{ border: '1px solid #eef2f5', borderRadius: 8, padding: '12px 12px 6px', background: '#fafbfc' }}>
        {!chart ? (
          <div style={{ height: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a99a8', fontSize: 12 }}>
            No history available for this window.
          </div>
        ) : (
          <svg width="100%" viewBox="0 0 420 130" style={{ display: 'block' }} role="img" aria-label={`${metric.label} around the detection, with the alarm limit marked`}>
            {chart.threshY != null && (
              <>
                <line x1="8" x2="412" y1={chart.threshY} y2={chart.threshY} stroke="#B3282D" strokeWidth="1" strokeDasharray="4 3" opacity="0.7" />
                <text x="410" y={chart.threshY - 4} textAnchor="end" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 9, fontWeight: 600, fill: '#B3282D' }}>
                  alarm limit {chart.threshVal}
                </text>
              </>
            )}
            <path d={chart.areaPath} fill="rgba(31,58,110,0.10)" />
            <path d={chart.linePath} stroke="#1F3A6E" strokeWidth="2" fill="none" strokeLinejoin="round" />
            <line x1={chart.mark[0]} x2={chart.mark[0]} y1="8" y2="112" stroke="#B3282D" strokeWidth="1.2" strokeDasharray="3 3" />
            <circle cx={chart.mark[0]} cy={chart.mark[1]} r="4" fill="#B3282D" stroke="#ffffff" strokeWidth="1.8" />
            <text x={chart.mark[0]} y="124" textAnchor="middle" style={{ fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 9, fontWeight: 600, fill: '#B3282D' }}>detection</text>
          </svg>
        )}
      </div>
      {chart && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {chart.readings.map((r) => (
            <span key={r.k} style={{ fontSize: 11.5, border: '1px solid #dde4ea', borderRadius: 6, padding: '4px 10px', background: '#ffffff', color: '#5f6f7e' }}>
              {r.k} <b style={{ color: '#1a2530', fontVariantNumeric: 'tabular-nums' }}>{r.v}</b>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        {parseRules(event).map((rule) => (
          <span key={rule} style={{ fontSize: 10.5, fontWeight: 600, background: '#eef1f4', color: '#5f6f7e', borderRadius: 4, padding: '3px 8px' }}>
            {ruleLabel(rule)}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function ReviewDrawer({ event, points, reviewer, onClose, onReviewed, showToast }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const panelRef = useRef(null);
  const restoreFocusRef = useRef(null);

  const open = Boolean(event);

  // Move focus into the dialog on open, restore it to the invoking control
  // on close, and keep Tab inside while it is open.
  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector(FOCUSABLE);
    (first || panel)?.focus();

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const nodes = Array.from(panel.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (!nodes.length) return;
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === firstNode) {
        e.preventDefault();
        lastNode.focus();
      } else if (!e.shiftKey && document.activeElement === lastNode) {
        e.preventDefault();
        firstNode.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const toRestore = restoreFocusRef.current;
      if (toRestore && typeof toRestore.focus === 'function') toRestore.focus();
    };
  }, [open, onClose]);

  const submit = useCallback(async (status) => {
    if (submitting || !event) return;
    setSubmitting(true);
    setError(null);
    const patch = {
      status,
      reviewedBy: reviewer,
      rootCause: status === 'CONFIRMED' ? form.rootCause.trim() : (form.rootCause.trim() || form.notes.trim()),
      notes: form.notes.trim() || undefined,
    };
    if (status === 'CONFIRMED') {
      patch.faultType = form.faultType;
      patch.resolution = form.resolution.trim();
      if (form.faultEnd) patch.faultEnd = new Date(form.faultEnd).toISOString();
    } else {
      patch.resolution = form.resolution.trim() || 'No action — detection dismissed';
    }
    try {
      await api.reviewFaultEvent(event.id, patch);
      showToast(`${eventId(event)} ${status.toLowerCase()}, recorded by ${reviewer}`, status === 'CONFIRMED' ? '#4CC38A' : '#e08a80');
      setForm(EMPTY_FORM);
      onReviewed();
      onClose();
    } catch (err) {
      const detail = Array.isArray(err.details) ? ` (${err.details.join('; ')})` : '';
      setError(err.message + detail);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, event, reviewer, form, showToast, onReviewed, onClose]);

  if (!open) return null;

  const sev = severityOf(event);
  const sp = sevPill(sev);
  const initials = reviewer.split(/[\s.]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const setField = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Mirrors server/utils/pdmReviewValidation.js: CONFIRMED needs faultType +
  // rootCause + resolution; rejecting requires the reviewer's written
  // justification, which this form carries in notes.
  const canConfirm = Boolean(form.faultType && form.rootCause.trim() && form.resolution.trim());
  const canReject = Boolean(form.notes.trim());
  const titleId = `review-drawer-title-${event.id}`;

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(20,30,40,0.34)', zIndex: 60 }} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 480, background: '#ffffff', zIndex: 61, boxShadow: '-12px 0 32px rgba(16,24,32,0.14)', display: 'flex', flexDirection: 'column', animation: 'drawerIn .25s ease' }}
      >
        <div style={{ padding: '18px 24px', borderBottom: '1px solid #eef2f5', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 14, fontWeight: 600, color: '#33475a' }}>{eventId(event)}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 600, borderRadius: 4, padding: '3px 9px', background: sp.bg, color: sp.color }}>{sev}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 600, borderRadius: 99, padding: '3px 9px', background: '#FBF3E0', color: '#8a5f00', border: '1px solid #ecd9a8' }}>
                <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: '#B27400' }} />Pending Review
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 600, borderRadius: 99, padding: '3px 9px', background: sourcePill(event).bg, color: sourcePill(event).color }}>
                {sourceLabel(event)}
              </span>
            </div>
            <h2 id={titleId} style={{ margin: 0, fontSize: 16, fontWeight: 600, marginTop: 8 }}>{eventTitle(event)}</h2>
            <div style={{ fontSize: 12, color: '#8a99a8', marginTop: 3 }}>
              Detected {shortStamp(event.detectedAt)} · {modelLine(event)} · confidence: {confidenceLabel(event)}
            </div>
          </div>
          <button
            type="button"
            className="hover-ghost"
            onClick={onClose}
            aria-label="Close review drawer"
            style={{ ...buttonReset, width: 30, height: 30, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5f6f7e', fontSize: 16, flexShrink: 0 }}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <EvidenceChart event={event} points={points} />

          <div style={{ borderTop: '1px solid #eef2f5', paddingTop: 16 }}>
            <h3 style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#8a99a8', marginBottom: 12 }}>Engineer review</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600, color: '#5f6f7e' }}>
                <span>Fault type <span style={{ color: '#B3282D' }} aria-hidden="true">*</span><span className="sr-only">(required)</span></span>
                <select required value={form.faultType} onChange={setField('faultType')} style={{ border: '1px solid #d3dbe2', borderRadius: 6, padding: '8px 10px', fontSize: 13, background: '#ffffff', color: '#1a2530' }}>
                  <option value="">Select…</option>
                  {FAULT_TYPES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600, color: '#5f6f7e' }}>
                <span>Fault end (optional)</span>
                <input type="datetime-local" value={form.faultEnd} onChange={setField('faultEnd')} style={{ border: '1px solid #d3dbe2', borderRadius: 6, padding: '7px 10px', fontSize: 12.5, color: '#1a2530' }} />
              </label>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600, color: '#5f6f7e', marginTop: 12 }}>
              <span>Root cause <span style={{ color: '#B3282D' }} aria-hidden="true">*</span><span className="sr-only">(required)</span></span>
              <input required value={form.rootCause} onChange={setField('rootCause')} placeholder="e.g. Outboard bearing outer-race defect" style={{ border: '1px solid #d3dbe2', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#1a2530' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600, color: '#5f6f7e', marginTop: 12 }}>
              <span>Resolution <span style={{ color: '#B3282D' }} aria-hidden="true">*</span><span className="sr-only">(required)</span></span>
              <input required value={form.resolution} onChange={setField('resolution')} placeholder="e.g. Bearing replacement scheduled under WO-2214" style={{ border: '1px solid #d3dbe2', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#1a2530' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600, color: '#5f6f7e', marginTop: 12 }}>
              <span>Notes <span style={{ fontWeight: 400, color: '#8a99a8' }}>(required to reject)</span></span>
              <textarea value={form.notes} onChange={setField('notes')} rows="3" placeholder="Observations, context, spectral analysis references…" style={{ border: '1px solid #d3dbe2', borderRadius: 6, padding: '8px 10px', fontSize: 13, resize: 'vertical', color: '#1a2530' }} />
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, background: '#f6f8fa', border: '1px solid #e6ebf0', borderRadius: 7, padding: '10px 12px' }}>
              <div aria-hidden="true" style={{ width: 26, height: 26, borderRadius: '50%', background: '#33475a', color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, fontWeight: 600 }}>{initials || '–'}</div>
              <div style={{ fontSize: 12.5, color: '#5f6f7e' }}>
                Will be recorded as reviewed by <b style={{ color: '#1a2530' }}>{reviewer}</b> at{' '}
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11.5 }}>
                  {new Date().toISOString().slice(0, 16).replace('T', ' ')}
                </span>
              </div>
            </div>
            {error && (
              <div role="alert" style={{ marginTop: 12, background: '#FBEAE8', border: '1px solid #efc4bf', color: '#B3282D', borderRadius: 7, padding: '10px 12px', fontSize: 12.5 }}>
                {error}
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid #eef2f5', background: '#fafbfc' }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <button
              type="button"
              className="hover-green"
              disabled={!canConfirm || submitting}
              onClick={() => submit('CONFIRMED')}
              style={{ ...buttonReset, flex: 1, background: '#177E4D', color: '#ffffff', borderRadius: 7, padding: 12, textAlign: 'center', fontSize: 14, fontWeight: 700, cursor: canConfirm && !submitting ? 'pointer' : 'not-allowed', boxShadow: '0 1px 3px rgba(23,126,77,0.35)', opacity: canConfirm && !submitting ? 1 : 0.45 }}
            >
              {submitting ? 'Saving…' : 'Confirm fault'}
            </button>
            <button
              type="button"
              className="hover-red-ghost"
              disabled={!canReject || submitting}
              onClick={() => submit('REJECTED')}
              style={{ ...buttonReset, flex: 1, background: '#ffffff', color: '#B3282D', border: '1.5px solid #B3282D', borderRadius: 7, padding: 11, textAlign: 'center', fontSize: 14, fontWeight: 700, cursor: canReject && !submitting ? 'pointer' : 'not-allowed', opacity: canReject && !submitting ? 1 : 0.45 }}
            >
              Reject detection
            </button>
          </div>
          <p style={{ margin: 0, fontSize: 11.5, color: '#8a99a8', marginTop: 10, textAlign: 'center' }}>
            This decision is written to the audit trail and cannot be edited from here.
          </p>
        </div>
      </div>
    </>
  );
}
