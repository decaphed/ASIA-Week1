// ─────────────────────────────────────────────────────────────────────────
// ManualReadingForm.jsx — hand-craft a single POST /api/data reading.
//
// Handy for testing the forecast pipeline or any other consumer without
// waiting on Node-RED: fill in the six metrics, submit, and it hits the same
// endpoint the simulator uses. Client-side range checks mirror
// server/utils/validation.js so the error usually shows up before the
// round-trip, but the server remains the source of truth.
// ─────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { postReading } from '../../services/api.js';
import { SENSORS } from '../../utils/constants.js';

const STATUSES = ['RUNNING', 'STOPPED', 'FAULT'];

function emptyValues() {
  return Object.fromEntries(SENSORS.map((s) => [s.key, '']));
}

export default function ManualReadingForm({ onSubmitted }) {
  const [values, setValues] = useState(emptyValues);
  const [status, setStatus] = useState('RUNNING');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null); // { kind: 'error'|'success', text }

  function setField(key, raw) {
    setValues((prev) => ({ ...prev, [key]: raw }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFeedback(null);

    const reading = { status };
    for (const s of SENSORS) {
      const raw = values[s.key];
      const num = Number(raw);
      if (raw === '' || Number.isNaN(num)) {
        setFeedback({ kind: 'error', text: `${s.label} is required` });
        return;
      }
      if (num < s.min || num > s.max) {
        setFeedback({ kind: 'error', text: `${s.label} must be between ${s.min} and ${s.max}` });
        return;
      }
      reading[s.key] = num;
    }

    setSubmitting(true);
    try {
      await postReading(reading);
      setFeedback({ kind: 'success', text: 'Reading submitted.' });
      onSubmitted?.();
    } catch (err) {
      const details = err?.response?.data?.details;
      const text = Array.isArray(details) && details.length
        ? details.join('; ')
        : err?.response?.data?.error || err.message || 'Submit failed';
      setFeedback({ kind: 'error', text });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="manual-entry" onSubmit={handleSubmit}>
      <div className="manual-entry__grid">
        {SENSORS.map((s) => (
          <label key={s.key} className="manual-entry__field">
            <span className="manual-entry__label">{s.label} <small>({s.unit})</small></span>
            <input
              className="manual-entry__input"
              type="number"
              step="any"
              min={s.min}
              max={s.max}
              placeholder={`${s.min}–${s.max}`}
              value={values[s.key]}
              onChange={(e) => setField(s.key, e.target.value)}
            />
          </label>
        ))}
        <label className="manual-entry__field">
          <span className="manual-entry__label">Status</span>
          <select
            className="manual-entry__input"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
          </select>
        </label>
      </div>

      <div className="manual-entry__actions">
        <button type="submit" className="manual-entry__submit" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit Reading'}
        </button>
        {feedback && (
          <span className={`manual-entry__feedback manual-entry__feedback--${feedback.kind}`}>
            {feedback.text}
          </span>
        )}
      </div>
    </form>
  );
}
