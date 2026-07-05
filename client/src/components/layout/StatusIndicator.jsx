// ─────────────────────────────────────────────────────────────────────────
// StatusIndicator.jsx — a single coloured "pill" showing a connection state.
//
// status is one of: 'online' | 'offline' | 'unknown'. The colour + pulse come
// entirely from CSS (.status--online etc.), so this component is pure props.
// ─────────────────────────────────────────────────────────────────────────

export default function StatusIndicator({ label, status = 'unknown' }) {
  return (
    <div className={`status status--${status}`} title={`${label}: ${status}`}>
      <span className="status__dot" />
      <span className="status__label">{label}</span>
    </div>
  );
}
