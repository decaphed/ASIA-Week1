// ─────────────────────────────────────────────────────────────────────────
// ReviewForm.jsx — right column of the detail view. Renders read-only
// (mode='view', for already-reviewed events) or editable (mode='edit', for
// a fresh review or an in-progress amend).
// ─────────────────────────────────────────────────────────────────────────

import { FAULT_TYPES, ONGOING_WINDOW_SECONDS } from '../../utils/constants.js';
import { formatDateTime } from '../../utils/formatters.js';

function ReadOnlySummary({ event, onAmend }) {
  return (
    <div className="review-form review-form--readonly">
      <dl className="timing-dl">
        <div className="timing-dl__row"><dt>Status</dt><dd>{event.status}</dd></div>
        <div className="timing-dl__row"><dt>Fault type</dt><dd>{event.faultType ?? '--'}</dd></div>
        <div className="timing-dl__row"><dt>Fault end</dt><dd>{formatDateTime(event.faultEnd)}</dd></div>
        <div className="timing-dl__row"><dt>Root cause</dt><dd>{event.rootCause || '--'}</dd></div>
        <div className="timing-dl__row"><dt>Resolution</dt><dd>{event.resolution || '--'}</dd></div>
        <div className="timing-dl__row"><dt>Notes</dt><dd>{event.notes || '--'}</dd></div>
        <div className="timing-dl__row"><dt>Reviewed by</dt><dd>{event.reviewedBy ?? '--'}</dd></div>
        <div className="timing-dl__row"><dt>Reviewed at</dt><dd>{formatDateTime(event.reviewedAt)}</dd></div>
      </dl>
      <button type="button" className="manual-entry__submit" onClick={onAmend}>
        Amend review
      </button>
    </div>
  );
}

export default function ReviewForm({
  event, mode, formState, setFormState, reviewerIdentity, submitting, feedback,
  showAmendConfirm, onSubmit, onCancel, onAmend, onAmendConfirm, onAmendCancel,
}) {
  if (mode === 'view') {
    return (
      <>
        <ReadOnlySummary event={event} onAmend={onAmend} />
        {showAmendConfirm && (
          <div className="review-stale-warning" role="alertdialog" aria-label="Confirm amend">
            <p>
              Amending overwrites this event&apos;s prior decision and reviewer/timestamp, with no
              audit trail of what it used to say. Continue?
            </p>
            <button type="button" className="manual-entry__submit" onClick={onAmendConfirm}>
              Yes, amend
            </button>{' '}
            <button type="button" onClick={onAmendCancel}>Cancel</button>
          </div>
        )}
      </>
    );
  }

  const set = (field) => (e) => setFormState((s) => ({ ...s, [field]: e.target.value }));

  return (
    <form
      className="review-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="review-form__decision">
        <button
          type="button"
          aria-pressed={formState.decision === 'CONFIRMED'}
          className={`review-form__decision-btn${formState.decision === 'CONFIRMED' ? ' is-active' : ''}`}
          onClick={() => setFormState((s) => ({ ...s, decision: 'CONFIRMED' }))}
        >
          Confirm fault
        </button>
        <button
          type="button"
          aria-pressed={formState.decision === 'REJECTED'}
          className={`review-form__decision-btn${formState.decision === 'REJECTED' ? ' is-active' : ''}`}
          onClick={() => setFormState((s) => ({ ...s, decision: 'REJECTED' }))}
        >
          Reject (false alarm)
        </button>
      </div>

      {formState.decision === 'CONFIRMED' && (
        <>
          {/* A plain div, not <label> — <label> forwards clicks on its own
              text to the first labelable descendant, which would silently
              select the first fault-type chip whenever this heading text
              itself was clicked. */}
          <div className="review-form__label">
            Fault type
            <div className="review-form__chip-group" role="group" aria-label="Fault type">
              {FAULT_TYPES.map((ft) => (
                <button
                  key={ft}
                  type="button"
                  aria-pressed={formState.faultType === ft}
                  className={`review-filters__tab${formState.faultType === ft ? ' is-active' : ''}`}
                  onClick={() => setFormState((s) => ({ ...s, faultType: ft }))}
                >
                  {ft}
                </button>
              ))}
            </div>
          </div>

          <label className="review-form__label">
            Fault ended at
            <input
              className="manual-entry__input"
              type="datetime-local"
              value={formState.faultEnd}
              onChange={set('faultEnd')}
            />
          </label>
          <p className="review-footnote">
            Confirming sets the training buffer to end 1 hour after this time.
          </p>
          {event.status === 'PENDING_REVIEW' &&
            event.lastSeenWindowEnd &&
            (Date.now() - Date.parse(event.lastSeenWindowEnd)) / 1000 <= ONGOING_WINDOW_SECONDS && (
              <p className="review-stale-warning">
                This fault is still re-triggering. Reviewing it now closes it — later windows will
                open a new event rather than extending this one.
              </p>
            )}

          <label className="review-form__label">
            Resolution <span className="review-footnote" style={{ marginTop: 0 }}>(required)</span>
            <textarea className="manual-entry__input" value={formState.resolution} onChange={set('resolution')} />
          </label>
        </>
      )}

      {formState.decision && (
        <label className="review-form__label">
          Root cause{' '}
          <span className="review-footnote" style={{ marginTop: 0 }}>
            {formState.decision === 'REJECTED' ? '(required — why was this a false alarm?)' : '(required)'}
          </span>
          <textarea className="manual-entry__input" value={formState.rootCause} onChange={set('rootCause')} />
        </label>
      )}

      {formState.decision && (
        <label className="review-form__label">
          Notes
          <textarea className="manual-entry__input" value={formState.notes} onChange={set('notes')} />
        </label>
      )}

      {reviewerIdentity?.username ? (
        // The server persists the signed-in Authentik identity regardless of
        // what's sent here (pdmController.js) — read-only, not just
        // pre-filled, so the form never implies a reviewer can attribute a
        // decision to anyone else.
        <div className="review-form__label">
          Reviewed by
          <div className="manual-entry__input manual-entry__input--readonly">{reviewerIdentity.username}</div>
        </div>
      ) : (
        // No Authentik identity on this request (dev/local access, outside
        // Traefik's forward-auth gate) — the server falls back to trusting
        // whatever's typed here, so it has to stay editable.
        <label className="review-form__label">
          Reviewed by
          <input className="manual-entry__input" type="text" value={formState.reviewedBy} onChange={set('reviewedBy')} />
        </label>
      )}

      {feedback && (
        <p className={`manual-entry__feedback manual-entry__feedback--${feedback.kind}`}>{feedback.text}</p>
      )}

      <div className="review-form__actions">
        <button type="submit" className="manual-entry__submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save review'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
