-- Up Migration

-- 005_training_corpus.sql — §10.5's persistent Tier 2 training corpus,
-- plus a small training_runs table for retrain/promotion bookkeeping.
--
-- training_corpus: one row per (bufferId, windowEnd) — a materialized,
-- uniformly-featured view over confirmed fault_events rows, kept separate
-- from fault_events itself so a corpus-shape change (label scheme, feature
-- recomputation) never has to touch the HITL/audit table. Node owns every
-- write here (server/services/corpusMaterializationService.js); Python
-- reads it via a read-only role for training (§10.6 item 2's resolution).
--
-- bufferId is namespaced TEXT, not a bare integer: "fault_events:<id>"
-- today (every current sourceType), "upload:<uploadId>:<windowIndex>"
-- reserved for the not-yet-built external-upload entry point (§10.4 Entry
-- point 2), which has no fault_events row to key off. faultEventId is a
-- REAL enforced FK for the three sourceTypes that do have one — fault_events
-- is a plain BIGSERIAL, NOT a hypertable (see 002_fault_events.sql's own
-- header on why processedTelemetryId's FK to the processed_telemetry
-- hypertable couldn't be enforced the same way; that obstacle doesn't apply
-- here). The CHECK constraint below ties bufferId and faultEventId together
-- so the two encodings of "which fault_events row this descends from" can
-- never silently disagree (caught in design review — code-reviewer flagged
-- the redundancy as a real corruption risk for held-out-by-buffer
-- evaluation if left unconstrained).
--
-- featureCodeVersion (not in the original §10.5 sketch, added during design
-- review — mle-reviewer's D2 finding): every row in a buffer is recomputed
-- UNIFORMLY at materialization time (no "keep the trigger window's stored
-- snapshot verbatim" special case — that mixed live-captured and
-- after-the-fact-recomputed features within one buffer, a silent
-- intra-buffer skew risk). This column records which feature-code version
-- (fault_events.featureSnapshot's own preprocessingVersion, e.g. 'v3-py')
-- produced this row's featureSnapshot, so a training-time discrepancy
-- across rows of the same buffer is at least detectable, not silent.
CREATE TABLE training_corpus (
  id                  BIGSERIAL PRIMARY KEY,

  "bufferId"          TEXT NOT NULL,
  "faultEventId"      BIGINT REFERENCES fault_events(id),
  "windowEnd"         TIMESTAMPTZ NOT NULL,

  "featureSnapshot"   JSONB NOT NULL,          -- same fixed shape as fault_events.featureSnapshot
  "featureCodeVersion" TEXT NOT NULL,           -- e.g. 'v3-py' — see header comment

  -- Resolved per §10.6 item 4 (design review, D1): a fault_events.faultType
  -- string for a CONFIRMED FLAGGED/MANUAL_BUFFER/EXTERNAL_UPLOAD row, or
  -- 'NORMAL' for a NEGATIVE_SAMPLE row. PENDING_REVIEW/REJECTED/null-
  -- faultType rows are never materialized at all (not relabeled) — status
  -- is eligibility, not label content.
  "label"             TEXT NOT NULL,
  "eventType"         TEXT NOT NULL,            -- carried through from fault_events, for traceability
  "sourceType"        TEXT NOT NULL,            -- TIER1_FLAGGED | NEGATIVE_SAMPLE | MANUAL_BUFFER | EXTERNAL_UPLOAD
  "thresholdsVersion" TEXT,

  -- Populated only for the not-yet-built EXTERNAL_UPLOAD path.
  "uploadId"          TEXT,
  "uploadedAt"        TIMESTAMPTZ,
  "uploadedBy"        TEXT,

  -- Dedup/staleness bookkeeping: a re-confirmation (e.g. a HITL correction)
  -- updates a row in place via UPSERT ... WHERE "sourceUpdatedAt" <
  -- EXCLUDED."sourceUpdatedAt", never duplicates it. corpusRowVersion bumps
  -- on every such update.
  "sourceUpdatedAt"   TIMESTAMPTZ NOT NULL,
  "corpusRowVersion"  INTEGER NOT NULL DEFAULT 1,
  "materializedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE ("bufferId", "windowEnd"),
  CONSTRAINT training_corpus_label_check
    CHECK ("label" IN ('NORMAL', 'THERMAL', 'CAVITATION', 'BEARING', 'IMPELLER_WEAR', 'SEAL_LEAK', 'MISALIGNMENT', 'DRY_RUN', 'OTHER')),
  CONSTRAINT training_corpus_source_type_check
    CHECK ("sourceType" IN ('TIER1_FLAGGED', 'NEGATIVE_SAMPLE', 'MANUAL_BUFFER', 'EXTERNAL_UPLOAD')),
  -- Ties bufferId's string encoding to faultEventId's integer FK so they
  -- can never silently disagree (design-review finding).
  CONSTRAINT training_corpus_buffer_fault_event_consistency
    CHECK ("faultEventId" IS NULL OR "bufferId" = 'fault_events:' || "faultEventId")
);

CREATE INDEX idx_training_corpus_label ON training_corpus ("label");
CREATE INDEX idx_training_corpus_source_type ON training_corpus ("sourceType");
CREATE INDEX idx_training_corpus_fault_event ON training_corpus ("faultEventId");
CREATE INDEX idx_training_corpus_window_end ON training_corpus ("windowEnd");

-- pdm/app/corpus.py's read-only role (db/init/03-create-pdm-corpus-
-- readonly-role.sh) needs SELECT on this table — but that role can't be
-- granted on a table until the table exists, so this can't live in the
-- init script itself (which runs before any migration, including this
-- one). Conditional on the role actually existing: on a fresh deployment
-- where the init script already ran, this grants immediately; on an
-- existing deployment where the role hasn't been created yet (e.g. it
-- predates this migration), this is a harmless no-op — re-run
-- `GRANT SELECT ON training_corpus TO pdm_corpus_readonly;` by hand once
-- the role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pdm_corpus_readonly') THEN
    GRANT SELECT ON training_corpus TO pdm_corpus_readonly;
  END IF;
END
$$;

-- training_runs: retrain/promotion bookkeeping (§10.5's "every retrained
-- model artifact stamped with the corpus version it trained on" +
-- champion/challenger promotion gate). Lives in Postgres, not a separate
-- Python-owned SQLite store (design review: pdm/ already gains a read-only
-- Postgres role for the corpus itself, so a second DB technology for this
-- much smaller amount of data isn't worth SQLite's single-writer risk).
-- Node owns every write here too — pdm/app/retrain.py computes a result and
-- hands it to server/scripts/recordTrainingRun.js, which does the actual
-- INSERT, keeping Python strictly read-only against Postgres (§3.4's
-- invariant, unchanged).
--
-- "corpusRowManifest" persists the exact (bufferId, windowEnd,
-- corpusRowVersion) tuples the hash was computed over — not just the hash
-- itself (design review, D4: a hash alone can prove drift happened later
-- but can't reconstruct what changed, since training_corpus is a live,
-- upsert-in-place table with no row history of its own).
CREATE TABLE training_runs (
  id                    BIGSERIAL PRIMARY KEY,

  "corpusContentHash"   TEXT NOT NULL,
  "corpusRowManifest"   JSONB NOT NULL,
  "corpusRowCount"      INTEGER NOT NULL,

  "trainedAt"           TIMESTAMPTZ NOT NULL,
  "metrics"             JSONB NOT NULL,          -- per-class precision/recall etc. (pdm/app/promotion.py's EvalMetrics)
  "artifactPath"        TEXT,                     -- where the trained model artifact was written, once model.py is real

  "promoted"            BOOLEAN NOT NULL DEFAULT false,
  "promotionReason"     TEXT NOT NULL,             -- human-readable decision summary, always populated (pass or fail)
  "championRunIdAtEval" BIGINT REFERENCES training_runs(id),  -- which run (if any) this one was compared against

  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_training_runs_promoted ON training_runs ("promoted");


-- Down Migration

-- 005_training_corpus.down.sql — reverse of 005_training_corpus.sql.
DROP TABLE IF EXISTS training_runs;
DROP TABLE IF EXISTS training_corpus;
