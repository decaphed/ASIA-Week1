// ─────────────────────────────────────────────────────────────────────────
// ErrorBanner.jsx — a friendly, non-scary error message with optional retry.
//
// role="alert" tells screen readers to announce it. We show human-readable
// text (not raw stack traces) so the operator understands what to do.
// ─────────────────────────────────────────────────────────────────────────

export default function ErrorBanner({ title = 'Something went wrong', message, onRetry }) {
  return (
    <div className="error-banner" role="alert">
      <div className="error-banner__content">
        <strong className="error-banner__title">{title}</strong>
        {message && <span className="error-banner__message">{message}</span>}
      </div>
      {onRetry && (
        <button className="error-banner__retry" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
