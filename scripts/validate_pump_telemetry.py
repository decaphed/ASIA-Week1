#!/usr/bin/env python3
"""
validate_pump_telemetry.py -- independent checks on the corpus produced by
generate_pump_telemetry.py.

Deliberately re-derives everything from the written files rather than from the
generator's in-memory state, so a bug in the generator cannot hide behind a
shared assumption. Streams one day-partition at a time and carries the boundary
rows across, so peak memory stays flat regardless of corpus size.

Exit status is 0 when every check passes, 1 otherwise.
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

METRICS = ("flowRate", "rpm", "vibration", "suctionPressure",
           "dischargePressure", "motorTemp")

RANGE = {
    "flowRate": (0.0, 500.0), "rpm": (0.0, 5000.0), "vibration": (0.0, 25.0),
    "suctionPressure": (0.0, 10.0), "dischargePressure": (0.0, 25.0),
    "motorTemp": (0.0, 150.0),
}

FAULT_TYPES = {"THERMAL", "CAVITATION", "BEARING", "IMPELLER_WEAR",
               "SEAL_LEAK", "MISALIGNMENT", "DRY_RUN"}
STATUSES = {"RUNNING", "STOPPED", "FAULT"}

EPISODE_BUFFER_S = 3600
SPIN_GUARD_S = 120       # exclusion radius around shutdowns for the smoothness check
MIN_EPISODES = 180
MIN_PER_TYPE = 20
DRY_RUN_DURATION_S = (120, 600)
FAULT_DURATION_S = (600, 2400)

failures: list[str] = []
notes: list[str] = []


def check(ok: bool, label: str, detail: str = "") -> None:
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}{('  -- ' + detail) if detail else ''}")
    if not ok:
        failures.append(label)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=Path("data/pump-telemetry"))
    ap.add_argument("--manifest", type=Path,
                    default=Path("data/pump-telemetry-episodes.csv"))
    ap.add_argument("--expect-days", type=int, default=90)
    args = ap.parse_args()

    parts = sorted(args.data.glob("date=*/part-*.parquet"))
    if not parts:
        print(f"no partitions under {args.data}", file=sys.stderr)
        return 1
    print(f"validating {len(parts)} day partitions under {args.data}\n")

    # ── streaming accumulators ────────────────────────────────────────────
    total = 0
    ts_ok = True
    prev_ts: int | None = None
    prev_status: str | None = None
    prev_prev_status: str | None = None

    nulls = 0
    bad_range: Counter[str] = Counter()
    bad_precision: Counter[str] = Counter()
    rpm_zero_running = 0
    bad_status = 0
    label_violations = 0
    isolated_faults = 0
    status_counts: Counter[str] = Counter()

    # run-length encoding of the status column, rebuilt from the files
    runs: list[list] = []            # [status, start_epoch, length, {faultTypes}]

    # smoothness: |x[t] - x[t-1]| inside steady RUNNING stretches
    max_step = {m: 0.0 for m in METRICS}
    step_sum = {m: 0.0 for m in METRICS}
    step_n = 0
    tail = None                      # last row of the previous partition

    for part in parts:
        tbl = pq.read_table(part)
        cols = {name: tbl.column(name) for name in tbl.column_names}

        ts = cols["timestamp"].to_numpy().astype("datetime64[s]").astype(np.int64)
        status = np.asarray(cols["status"].to_pylist(), dtype=object)
        ftype = np.asarray(cols["faultType"].to_pylist(), dtype=object)
        vals = {m: cols[m].to_numpy() for m in METRICS}

        total += ts.shape[0]

        # timestamps: strictly increasing, exactly 1 s apart, no gaps/dupes
        if prev_ts is not None and ts[0] != prev_ts + 1:
            ts_ok = False
        if not np.all(np.diff(ts) == 1):
            ts_ok = False
        prev_ts = int(ts[-1])

        for m in METRICS:
            v = vals[m]
            nulls += int(np.isnan(v).sum())
            lo, hi = RANGE[m]
            bad_range[m] += int(((v < lo) | (v > hi)).sum())
            # one decimal place, exactly -- no 47.384729103
            bad_precision[m] += int((np.abs(v * 10 - np.round(v * 10)) > 1e-6).sum())

        is_running = status == "RUNNING"
        is_fault = status == "FAULT"
        is_stopped = status == "STOPPED"

        bad_status += int(sum(s not in STATUSES for s in status))
        rpm_zero_running += int((vals["rpm"][~is_stopped] == 0.0).sum())

        # faultType present exactly when status is FAULT, and always valid
        label_violations += int(sum(
            (f is None) if fault else (f is not None)
            for fault, f in zip(is_fault, ftype)))
        label_violations += int(sum(
            f is not None and f not in FAULT_TYPES for f in ftype))

        for s in status:
            status_counts[s] += 1

        # Second-to-second movement in STEADY RUNNING. The 60 s restart ramp
        # after a shutdown is labelled RUNNING but is a genuine physical
        # spin-up, so it is excluded here -- otherwise the ramp, not the
        # noise, would set the maximum and the number would say nothing about
        # whether consecutive samples jump independently.
        near = np.convolve((~is_running).astype(np.int32),
                           np.ones(2 * SPIN_GUARD_S + 1, dtype=np.int32),
                           mode="same") > 0
        pair = is_running[:-1] & is_running[1:] & ~near[:-1] & ~near[1:]
        if pair.any():
            for m in METRICS:
                d = np.abs(np.diff(vals[m]))[pair]
                max_step[m] = max(max_step[m], float(d.max()))
                step_sum[m] += float(d.sum())
            step_n += int(pair.sum())

        # isolated FAULT rows: RUNNING immediately before AND after
        seq_status = status if tail is None else np.concatenate(([tail], status))
        mid = seq_status[1:-1]
        iso = (mid == "FAULT") & (seq_status[:-2] == "RUNNING") & (seq_status[2:] == "RUNNING")
        isolated_faults += int(iso.sum())
        tail = status[-1]

        # run-length encode the status column across partition boundaries
        base = int(ts[0])
        edges = np.flatnonzero(np.concatenate(([True], status[1:] != status[:-1])))
        for i, e in enumerate(edges):
            end = edges[i + 1] if i + 1 < len(edges) else len(status)
            s, start_epoch, length = status[e], base + int(e), int(end - e)
            types = {f for f in ftype[e:end] if f is not None}
            if runs and runs[-1][0] == s and runs[-1][1] + runs[-1][2] == start_epoch:
                runs[-1][2] += length
                runs[-1][3] |= types
            else:
                runs.append([s, start_epoch, length, types])

    # ── report ────────────────────────────────────────────────────────────
    print("Structure")
    check(ts_ok, "timestamps strictly increasing, 1 s apart, no gaps or duplicates")
    check(total == len(parts) * 86_400, "row count",
          f"{total:,} rows over {len(parts)} days")
    # Guards a truncated write: without this, a corpus cut short still passes
    # every relative check because they all scale with whatever was found.
    check(len(parts) == args.expect_days,
          f"corpus covers the full {args.expect_days} days",
          f"{len(parts)} day partitions present")
    check(nulls == 0, "no missing metric values")
    check(bad_status == 0, "status values all in {RUNNING, STOPPED, FAULT}")

    print("\nValues")
    check(sum(bad_range.values()) == 0, "all metrics within their physical range",
          "; ".join(f"{m} {c}" for m, c in bad_range.items() if c) or "0 violations")
    check(sum(bad_precision.values()) == 0, "every value at exactly 1 decimal place",
          "; ".join(f"{m} {c}" for m, c in bad_precision.items() if c) or "0 violations")
    check(rpm_zero_running == 0, "rpm never exactly 0 unless STOPPED",
          f"{rpm_zero_running} violations")

    print("\nLabels")
    check(label_violations == 0,
          "faultType non-null exactly when status is FAULT, and always valid",
          f"{label_violations} violations")

    fault_runs = [r for r in runs if r[0] == "FAULT"]
    stop_runs = [r for r in runs if r[0] == "STOPPED"]
    mixed = [r for r in fault_runs if len(r[3]) != 1]
    check(not mixed, "each FAULT episode carries exactly one faultType",
          f"{len(mixed)} mixed episodes")

    print("\nEpisodes")
    check(isolated_faults == 0,
          "no isolated FAULT row with RUNNING on both sides",
          f"{isolated_faults} found")
    check(len(fault_runs) >= MIN_EPISODES, "fault episode count",
          f"{len(fault_runs)} contiguous FAULT episodes")

    per_type = Counter(next(iter(r[3])) for r in fault_runs if r[3])
    worst = min(per_type.values()) if per_type else 0
    check(len(per_type) == len(FAULT_TYPES) and worst >= MIN_PER_TYPE,
          f"all 7 fault types present with >= {MIN_PER_TYPE} episodes",
          ", ".join(f"{k}={v}" for k, v in sorted(per_type.items())))

    too_short = [r for r in fault_runs if r[2] < DRY_RUN_DURATION_S[0]]
    check(not too_short, "no fault episode shorter than 2 minutes",
          f"shortest {min(r[2] for r in fault_runs)} s")

    bad_dur = []
    for r in fault_runs:
        lo, hi = DRY_RUN_DURATION_S if next(iter(r[3])) == "DRY_RUN" else FAULT_DURATION_S
        if not lo <= r[2] <= hi:
            bad_dur.append(r)
    check(not bad_dur, "every episode duration inside its band "
                       "(DRY_RUN 2-10 min, others 10-40 min)",
          f"{len(bad_dur)} outside")

    # >= 1 h of *normal RUNNING* either side of every episode
    short_buf = 0
    for i, r in enumerate(runs):
        if r[0] != "FAULT":
            continue
        before = runs[i - 1] if i > 0 else None
        after = runs[i + 1] if i + 1 < len(runs) else None
        if before is None or before[0] != "RUNNING" or before[2] < EPISODE_BUFFER_S:
            short_buf += 1
        elif after is None or after[0] != "RUNNING" or after[2] < EPISODE_BUFFER_S:
            short_buf += 1
    check(short_buf == 0,
          ">= 1 h of normal RUNNING immediately before and after every episode",
          f"{short_buf} episodes short")

    print("\nShutdowns")
    check(bool(stop_runs), "STOPPED episodes present",
          f"{len(stop_runs)} shutdowns, "
          f"{min(r[2] for r in stop_runs)}-{max(r[2] for r in stop_runs)} s")

    print("\nMix")
    share = {k: v / total for k, v in status_counts.items()}
    check(share.get("RUNNING", 0) >= 0.95, "RUNNING share >= 95%",
          ", ".join(f"{k} {v:.3%}" for k, v in sorted(share.items())))

    print(f"\nContinuity: 1 s change in steady RUNNING ({step_n:,} sample pairs)")
    print(f"  {'metric':<18} {'mean':>8} {'max':>8}   max as % of full scale")
    worst_pct = 0.0
    for m in METRICS:
        span = RANGE[m][1] - RANGE[m][0]
        pct = max_step[m] / span * 100
        worst_pct = max(worst_pct, pct)
        print(f"  {m:<18} {step_sum[m] / max(step_n, 1):>8.2f} "
              f"{max_step[m]:>8.1f}   {pct:.2f}%")
    check(worst_pct < 3.0,
          "no metric jumps more than 3% of full scale between adjacent seconds",
          f"worst {worst_pct:.2f}%")

    # ── manifest cross-check ──────────────────────────────────────────────
    print("\nManifest")
    if not args.manifest.exists():
        check(False, "manifest exists", str(args.manifest))
    else:
        with args.manifest.open(encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
        check(len(rows) == len(fault_runs),
              "one manifest row per fault episode",
              f"{len(rows)} rows vs {len(fault_runs)} episodes")

        def parse(s: str) -> int:
            return int(datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")
                       .replace(tzinfo=timezone.utc).timestamp())

        mismatch = 0
        for row, run in zip(rows, sorted(fault_runs, key=lambda r: r[1])):
            if parse(row["startTimestamp"]) != run[1]:
                mismatch += 1
            elif parse(row["endTimestamp"]) != run[1] + run[2] - 1:
                mismatch += 1
            elif row["faultType"] != next(iter(run[3])):
                mismatch += 1
            elif int(row["durationSeconds"]) != run[2]:
                mismatch += 1
        check(mismatch == 0,
              "manifest start/end/type/duration agree with the telemetry",
              f"{mismatch} mismatched rows")

        peaks = [float(r["peakSeverity"]) for r in rows]
        check(all(0.0 < p <= 1.0 for p in peaks), "peakSeverity within (0, 1]",
              f"min {min(peaks):.3f} max {max(peaks):.3f}")

    # ── weekly clustering ─────────────────────────────────────────────────
    print("\nWeekly episode counts (bad weeks should roughly double the mean)")
    start = min(r[1] for r in runs)
    weekly = Counter((r[1] - start) // (7 * 86_400) for r in fault_runs)
    mean = len(fault_runs) / (len(weekly) or 1)
    for w in sorted(weekly):
        flag = "  <-- bad week" if weekly[w] >= 1.6 * mean else ""
        print(f"  week {w + 1:>2}  {weekly[w]:>3}{flag}")
    n_bad = sum(1 for w in weekly if weekly[w] >= 1.6 * mean)
    check(2 <= n_bad <= 3, "2-3 bad weeks carry roughly double the mean",
          f"mean {mean:.1f}/week, {n_bad} bad weeks")

    print()
    if failures:
        print(f"FAILED ({len(failures)}): " + "; ".join(failures))
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
