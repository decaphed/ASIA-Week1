// ─────────────────────────────────────────────────────────────────────────
// FaultReviewDetailPage.jsx — #/review/:id. Owns fetch, form state, submit.
// Composed inside FaultReviewPage.jsx rather than routed via App.jsx's
// PAGES map, since it needs no props beyond the id already flowing through
// FaultReviewPage's `param`.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import Spinner from '../components/ui/Spinner.jsx';
import ErrorBanner from '../components/ui/ErrorBanner.jsx';
import EvidencePanel from '../components/pdm/EvidencePanel.jsx';
import ReviewForm from '../components/pdm/ReviewForm.jsx';
import { useAsync } from '../hooks/useAsync.js';
import { getFaultEvent, reviewFaultEvent, getWhoami } from '../services/api.js';
import { toLocalDatetimeInputValue } from '../utils/formatters.js';

function blankFormState(event) {
  return {
    decision: null,
    faultType: '',
    faultEnd: toLocalDatetimeInputValue(event.lastSeenWindowEnd),
    rootCause: '',
    resolution: '',
    notes: '',
    reviewedBy: '',
  };
}

function amendFormState(event) {
  return {
    decision: event.status === 'CONFIRMED' || event.status === 'REJECTED' ? event.status : null,
    faultType: event.faultType ?? '',
    faultEnd: toLocalDatetimeInputValue(event.faultEnd),
    rootCause: event.rootCause ?? '',
    resolution: event.resolution ?? '',
    notes: event.notes ?? '',
    reviewedBy: event.reviewedBy ?? '',
  };
}

// A field the user cleared (had a value, now blank) must be sent as '' to
// actually blank it server-side; a field that was NEVER touched must be
// omitted entirely — reviewFaultEvent merges via `patch.x ?? existing.x`,
// so `undefined` preserves the old value but '' overwrites it.
function optionalField(current, initial) {
  const c = current.trim();
  if (c) return current;
  if (initial && initial.trim()) return '';
  return undefined;
}

/**
 * Build a PATCH body. The server (server/utils/pdmReviewValidation.js)
 * requires non-blank rootCause + reviewedBy on both CONFIRMED and REJECTED,
 * and non-blank resolution + a valid faultType on CONFIRMED only — validate()
 * below blocks submission before this runs, so those fields are always
 * real values here, sent as-is (not run through the omit-if-untouched
 * logic, since the server no longer accepts them blank). `notes` is the one
 * field the server never requires, so it keeps the undefined-preserves /
 * ''-overwrites distinction: `initial` (the form-state snapshot seeded on
 * load/amend) tells "never touched" (omit) apart from "cleared" (send '').
 */
function buildReviewPatch(formState, initial) {
  const patch = {
    status: formState.decision,
    rootCause: formState.rootCause,
    reviewedBy: formState.reviewedBy,
  };
  if (formState.decision === 'CONFIRMED') {
    patch.faultType = formState.faultType;
    patch.faultEnd = new Date(formState.faultEnd).toISOString();
    patch.resolution = formState.resolution;
  }
  patch.notes = optionalField(formState.notes, initial?.notes);
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
}

export default function FaultReviewDetailPage({ id }) {
  const { data: event, error, loading, setData } = useAsync(() => getFaultEvent(id), id);

  const [mode, setMode] = useState('edit');
  const [formState, setFormState] = useState(null);
  const [showAmendConfirm, setShowAmendConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);
  // The signed-in Authentik identity — null fields when accessed outside
  // Traefik's forward-auth gate (dev/local). The server already ignores
  // whatever `reviewedBy` the client sends once it has an identity of its
  // own (pdmController.js), so fetching this here just lets the form show
  // what will actually be persisted instead of a stale/misleading input.
  const [identity, setIdentity] = useState(null);
  const initialFormStateRef = useRef(null);
  const prevEventIdRef = useRef(null);

  useEffect(() => {
    getWhoami().then(setIdentity).catch(() => setIdentity({ username: null, email: null, groups: [] }));
  }, []);

  // Once the signed-in identity is known and the form is editable, lock
  // reviewedBy to it — this is what the server will actually persist
  // (pdmController.js), so the field should never show anything else while
  // an identity is present. Runs on mode changes too, so confirming Amend
  // (which seeds the previous reviewer's name for display) immediately
  // switches to the current actor before any edit is made.
  useEffect(() => {
    if (mode !== 'edit' || !identity?.username || !formState) return;
    if (formState.reviewedBy === identity.username) return;
    setFormState((s) => ({ ...s, reviewedBy: identity.username }));
  }, [mode, identity, formState]);

  useEffect(() => {
    if (!event) return;
    // Only (re)initialize when this is genuinely a different event, not when
    // `event` merely changed identity because our own submit's PATCH
    // response was written into state via setData — that would otherwise
    // wipe the just-set success feedback before the redirect timeout fires.
    if (prevEventIdRef.current === event.id) return;
    prevEventIdRef.current = event.id;
    setMode(event.status === 'PENDING_REVIEW' ? 'edit' : 'view');
    const initial = event.status === 'PENDING_REVIEW' ? blankFormState(event) : null;
    initialFormStateRef.current = initial;
    setFormState(initial);
    setFeedback(null);
  }, [event]);

  if (loading && !event) return <Spinner label="Loading event…" />;
  if (error && !event) {
    const notFound = error.response?.status === 404;
    return (
      <ErrorBanner
        title={notFound ? `Event #${id} not found` : 'Could not load this event'}
        message={notFound ? undefined : 'Check your connection and try again.'}
      />
    );
  }
  if (!event) return null;

  // Mirrors server/utils/pdmReviewValidation.js's validateReviewPatch exactly
  // (rootCause + reviewedBy required on both terminal statuses; resolution +
  // faultType required on CONFIRMED only) so a user finds out about a
  // missing field here, not from a 400 after clicking Save.
  function validate() {
    if (!formState.decision) return 'Choose Confirm or Reject before saving.';
    if (!formState.rootCause.trim()) return 'Root cause is required.';
    if (!formState.reviewedBy.trim()) return 'Reviewed by is required.';
    if (formState.decision === 'CONFIRMED') {
      if (!formState.faultType) return 'Fault type is required to confirm.';
      if (!formState.faultEnd) return 'Fault end time is required to confirm.';
      if (Date.parse(formState.faultEnd) < Date.parse(event.faultStart)) {
        return 'Fault end cannot be before fault start.';
      }
      if (!formState.resolution.trim()) return 'Resolution is required to confirm.';
    }
    return null;
  }

  async function handleSubmit() {
    const validationError = validate();
    if (validationError) {
      setFeedback({ kind: 'error', text: validationError });
      return;
    }
    setSubmitting(true);
    setFeedback(null);
    try {
      const patch = buildReviewPatch(formState, initialFormStateRef.current);
      const updated = await reviewFaultEvent(id, patch);
      setData(updated);
      setFeedback({ kind: 'success', text: 'Review saved.' });
      setTimeout(() => {
        window.location.hash = '#/review';
      }, 1000);
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err.response?.data?.error ?? err.message ?? 'Failed to save review.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dashboard" id="review-detail">
      <a href="#/review" className="review-footnote">← Fault Review Queue</a>
      <div className="review-detail">
        <EvidencePanel event={event} />
        <ReviewForm
          event={event}
          mode={mode}
          formState={formState ?? blankFormState(event)}
          setFormState={setFormState}
          reviewerIdentity={identity}
          submitting={submitting}
          feedback={feedback}
          showAmendConfirm={showAmendConfirm}
          onSubmit={handleSubmit}
          onAmend={() => setShowAmendConfirm(true)}
          onAmendConfirm={() => {
            const seeded = amendFormState(event);
            initialFormStateRef.current = seeded;
            setFormState(seeded);
            setMode('edit');
            setShowAmendConfirm(false);
          }}
          onAmendCancel={() => setShowAmendConfirm(false)}
        />
      </div>
    </div>
  );
}
