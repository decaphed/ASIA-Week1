"""corpus.py — read-only access to the Postgres training_corpus table
(§10.5). §10.6 item 2's resolution: Python gets a read-only role against
the same database for this batch/training path — §3.4's "no DB access at
all" restriction only ever applied to the live per-window /score path
(SQLite's single-writer model, reasoned about specifically for that path),
which is unaffected; this is a narrower, additive exception for an
occasional, read-only, batch query. Python never writes application data
here — the write path is server/scripts/recordTrainingRun.js, keeping
§3.4's actual invariant ("Python never writes application data") intact.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def load_corpus(conn) -> list[dict[str, Any]]:
    """@param conn a psycopg connection using the read-only
        PDM_CORPUS_DB_URL role — passed in rather than opened here, so
        callers (and tests) control connection lifecycle and can supply a
        fixture cursor without a real Postgres instance.
    @returns training_corpus rows as plain dicts, chronological by windowEnd.
    """
    with conn.cursor() as cur:
        cur.execute(
            'SELECT id, "bufferId", "faultEventId", "windowEnd", "featureSnapshot", '
            '"featureCodeVersion", "label", "eventType", "sourceType", "thresholdsVersion", '
            '"corpusRowVersion" '
            'FROM training_corpus ORDER BY "windowEnd" ASC'
        )
        columns = [desc[0] for desc in cur.description]
        return [dict(zip(columns, row)) for row in cur.fetchall()]


def corpus_content_hash(corpus_rows: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """@returns (hash, manifest). manifest is the exact (bufferId,
    windowEnd, corpusRowVersion) tuple list the hash was computed over —
    persisted alongside the hash by recordTrainingRun.js, not just the
    hash itself (design review, D4: training_corpus is a live, upsert-in-
    place table with no row history of its own, so a hash alone can prove
    LATER that the corpus drifted but can't reconstruct WHAT it looked
    like at training time; the manifest is what makes that reconstructible).
    """
    manifest = sorted(
        (
            {
                "bufferId": row["bufferId"],
                "windowEnd": str(row["windowEnd"]),
                "corpusRowVersion": row["corpusRowVersion"],
            }
            for row in corpus_rows
        ),
        key=lambda m: (m["bufferId"], m["windowEnd"]),
    )
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    content_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return content_hash, manifest
