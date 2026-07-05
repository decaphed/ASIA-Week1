// ─────────────────────────────────────────────────────────────────────────
// Spinner.jsx — a small loading indicator with an accessible live region.
// ─────────────────────────────────────────────────────────────────────────

export default function Spinner({ label = 'Loading…' }) {
  return (
    <div className="spinner" role="status" aria-live="polite">
      <span className="spinner__dot" />
      <span className="spinner__text">{label}</span>
    </div>
  );
}
