#!/usr/bin/env python3
"""
generate_engine_telemetry.py -- synthetic 1 Hz telemetry for a single engine
unit, as a PRE-LABELED supervised-training corpus.

Migrated pump -> engine domain per docs/plan/2026-08-26-pump-to-engine-
migration.md Phase 6 (replaces generate_pump_telemetry.py). Physical model,
ranges, and fault profiles are ported from the Phase 5 rewrite of
node-red/flow.json's gen_reading -- the repo's single source of truth for
fault signatures, same relationship the pump-domain version of this script
had to the pump-domain flow.json.

This is NOT a simulation of a raw live sensor feed. `faultType` is ground
truth known at generation time -- the equivalent of a domain expert's
confirmed diagnosis after the fact. A real engine's instrumentation reports
readings and operational status, never a diagnosis (see the note in
node-red/flow.json's gen_reading, which deliberately withholds faultType
from the live stream). The label is included here precisely because that is
what makes the corpus usable for supervised training.

Physical model
--------------
Every metric is driven by ONE latent "load" variable L in [0.02, 1] -- how
hard the engine is working. L is an Ornstein-Uhlenbeck process (a
mean-reverting slow random walk, not white noise) pulled toward 0.5, so the
six metrics move together with real momentum instead of teleporting between
consecutive seconds. Only small, independent per-metric measurement noise is
added on top.

Base relationships at load L, no fault -- ported from the live simulator in
node-red/flow.json so the two corpora are interchangeable:

    engineRpm          = 100  + L * 1465
    lubOilPressure      = 0.858 + (1 - (1 - L)^2) * 4.75   [saturating: rises
                          fast then plateaus -- oil pump is driven off the
                          crank, unlike the other metrics below]
    fuelPressure        = 1.4  + L * 14.7
    coolantPressure      = 0.72 + L * 5.2
    lubOilTemperature   -- NOT instantaneous: thermally lagged toward
                          65 + L * 30 (see "Thermal lag" below)
    coolantTemperature  -- NOT instantaneous: thermally lagged toward
                          62 + L * 30

Fault deltas (FAULT_PROFILES) are also lifted verbatim from the Phase 5
node-red/flow.json rewrite, which is the repo's single source of truth for
fault signatures. Ranges (RANGE) are the Phase 0 empirical hard bounds from
engine-physics.yaml / docs/analysis/2026-08-26-train-csv-characterization.md.

Thermal lag
-----------
Unlike the pump domain's motorTemp (which only picked up a first-order lag
around shutdown transitions, otherwise tracking load instantaneously), BOTH
engine temperatures are lagged CONTINUOUSLY here, matching the Phase 5
node-red rewrite's design (a genuine improvement over the pump-domain
approach, not just a rename -- real engine thermal mass means temperature
never tracks load instantaneously, running or not). Implemented as an AR(1)
process chasing a load-and-fault-dependent target, reusing the same ar1()
helper the load process itself uses.

KNOWN LIMITATION: engine-physics.yaml's hard bounds (lubOilTemperature
65-95, coolantTemperature 60-108) were derived from data/train.csv, which
contains only engine-RUNNING rows (plan §3) -- there is no data-backed floor
for a fully cold-soaked, long-stopped engine, which would legitimately read
well below these bounds. This generator's STOPPED episodes are brief enough
(seconds to a few minutes, same schedule as the pump-domain version) that
temperatures never actually reach a cold-soak floor, so this limitation does
not surface in the generated corpus -- but it means a live ingest of a truly
cold engine (e.g. after an overnight shutdown) would currently hard-reject
at engine-physics.yaml's floor. Flagged for a future revisit, not fixed here
-- it is a Phase 1 range question, out of this script's scope.

Regimes
-------
RUNNING  ~96% of samples. Pure load-driven behaviour.
STOPPED  Occasional shutdowns, a few per week. engineRpm actually reaches
         zero: a 12 s coast-down drives the "energised" gate g from 1 to
         exactly 0. Oil and fuel pressure fall to zero (no fluid movement);
         coolant pressure decays toward a modest residual (a sealed system
         does not vent instantly); both temperatures continue their thermal
         lag toward a stopped-engine target rather than snapping to it. On
         restart the gate ramps back up over 60 s and everything follows
         smoothly.
FAULT    Discrete multi-minute episodes across 7 engine failure modes.
         Severity ramps smoothly 0 -> peak across the episode and the
         deviation is removed once the episode ends.

Determinism
-----------
Every random draw comes from a single numpy Generator seeded with SEED below.
Re-running with the same seed and the same --days reproduces the corpus
bit-for-bit.
"""

from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

# ─────────────────────────────────────────────────────────────────────────
# Reproducibility
# ─────────────────────────────────────────────────────────────────────────

SEED = 20260826

# ─────────────────────────────────────────────────────────────────────────
# Corpus shape
# ─────────────────────────────────────────────────────────────────────────

START = datetime(2026, 5, 1, tzinfo=timezone.utc)
DEFAULT_DAYS = 90
SECONDS_PER_DAY = 86_400

N_FAULT_EPISODES = 180
MIN_EPISODES_PER_TYPE = 20
N_BAD_WEEKS = 3            # spec allows 2-3; bad weeks carry ~2x the mean count

# Every fault episode is fenced by at least this much normal RUNNING data on
# each side. Two consecutive episodes therefore sit >= BUFFER apart, which
# means the hour after one IS the hour before the next -- both still normal.
EPISODE_BUFFER_S = 3600

FAULT_DURATION_S = (10 * 60, 40 * 60)
# FUEL_STARVATION is the fastest-onset failure mode (an engine stalls
# quickly when it runs out of fuel), so it gets its own shorter band -- the
# same role DRY_RUN played in the pump-domain version of this script.
FAST_ONSET_DURATION_S = (2 * 60, 10 * 60)
FAST_ONSET_TYPE = "FUEL_STARVATION"

STOPS_PER_WEEK = (3, 6)          # inclusive
STOP_SHORT_S = (20, 60)          # the common case
STOP_LONG_S = (60, 300)          # "a few minutes"
STOP_LONG_PROB = 0.4

SPIN_DOWN_S = 12                 # coast-down to a dead stop
SPIN_UP_S = 60                   # "ramp back up smoothly over about a minute"
THERMAL_TAIL_S = 1800            # let temperatures re-converge after a stop

# ─────────────────────────────────────────────────────────────────────────
# Load process (Ornstein-Uhlenbeck)
# ─────────────────────────────────────────────────────────────────────────

LOAD_TARGET = 0.5
LOAD_TAU_S = 600.0               # ~10 min mean-reversion time constant
LOAD_SIGMA = 0.12                # stationary std dev of L
LOAD_MIN, LOAD_MAX = 0.02, 1.0

# ─────────────────────────────────────────────────────────────────────────
# Metrics
# ─────────────────────────────────────────────────────────────────────────

METRICS = ("engineRpm", "lubOilPressure", "fuelPressure", "coolantPressure",
           "lubOilTemperature", "coolantTemperature")

LAGGED_METRICS = ("lubOilTemperature", "coolantTemperature")

# intercept, slope (value = intercept + slope * L) -- linear metrics only;
# lubOilPressure uses the saturating curve below instead, and the two
# lagged temperatures use LAG_BASE + LAG_SLOPE below.
BASE = {
    "engineRpm":     (100.0, 1465.0),
    "fuelPressure":   (1.4, 14.7),
    "coolantPressure": (0.72, 5.2),
}

# lubOilPressure's saturating curve: intercept + span * (1 - (1-L)^2).
OIL_PRESSURE_INTERCEPT = 0.858
OIL_PRESSURE_SPAN = 4.75

# Lagged-temperature targets: LAG_BASE + LAG_SLOPE * L (+ fault delta),
# chased via an AR(1) process rather than tracked instantaneously.
LAG_BASE = {"lubOilTemperature": 65.0, "coolantTemperature": 62.0}
LAG_SLOPE = {"lubOilTemperature": 30.0, "coolantTemperature": 30.0}
# AR(1) coefficient a = 1 - (per-second lag speed), matching the Phase 5
# node-red rewrite's step() speeds (0.02 / 0.015 per 1 Hz tick).
LAG_A = {"lubOilTemperature": 0.98, "coolantTemperature": 0.985}

# Reading with the engine de-energised (gate g = 0). Coolant pressure decays
# toward a modest residual rather than 0 -- a sealed system does not vent
# instantly. Temperatures don't use OFF_VALUE directly (they're lagged, see
# LAG_BASE), listed here only for completeness/consistency with the other
# metrics' gating.
OFF_VALUE = {
    "engineRpm": 0.0, "lubOilPressure": 0.0, "fuelPressure": 0.0,
    "coolantPressure": 0.3,
    "lubOilTemperature": 65.0, "coolantTemperature": 60.0,
}

# 1 sigma independent measurement noise, in engineering units. Deliberately
# small (real instrumentation-grade) so the shared load signal, not the
# noise, is what drives second-to-second movement. Scaled down from the
# Phase 5 live-simulator jitter amplitudes (this is a "cleaner" pre-labeled
# training corpus, not a live noisy feed -- same relationship the pump
# generator had to its own live simulator).
NOISE_SD = {
    "engineRpm": 3.3, "lubOilPressure": 0.011, "fuelPressure": 0.032,
    "coolantPressure": 0.018, "lubOilTemperature": 0.065, "coolantTemperature": 0.08,
}

# Residual dither still present when the engine is stopped, as a fraction of
# the running noise. engineRpm is 0.0: a stationary crankshaft reads a hard
# zero, same reasoning the pump domain's rpm/tachometer had.
OFF_NOISE_FRACTION = {
    "engineRpm": 0.0, "lubOilPressure": 0.1, "fuelPressure": 0.1,
    "coolantPressure": 0.15, "lubOilTemperature": 0.1, "coolantTemperature": 0.1,
}

# Hard physical bounds, from engine-physics.yaml (shared with server/ and
# pdm/) -- derived from docs/analysis/2026-08-26-train-csv-characterization.md,
# not hand-guessed. See the KNOWN LIMITATION note in the module docstring.
RANGE = {
    "engineRpm": (0.0, 2500.0), "lubOilPressure": (0.0, 8.5),
    "fuelPressure": (0.0, 23.0), "coolantPressure": (0.0, 9.0),
    "lubOilTemperature": (65.0, 95.0), "coolantTemperature": (60.0, 108.0),
}

# Softness of the asymptotic floor at 0 (see soft_floor). Metrics whose fault
# deltas can push them below zero need one; without it a severe fault would
# clip a flat, obviously-synthetic line at exactly 0.0 for minutes at a time.
SOFT_FLOOR_K = {
    "engineRpm": 40.0, "lubOilPressure": 0.3, "fuelPressure": 0.5,
    "coolantPressure": 0.2,
}

# Per-metric delta applied at severity = 1, scaled linearly by severity.
# Verbatim from the Phase 5 rewrite of node-red/flow.json's FAULT_PROFILES
# (docs/plan/2026-08-26-pump-to-engine-migration.md §4.2) -- engineering
# judgment, not derived from data/train.csv, which carries no fault-type
# supervision at all (plan §3).
FAULT_PROFILES: dict[str, dict[str, float]] = {
    "OIL_PRESSURE_LOSS": {"engineRpm": 0,    "lubOilPressure": -3.5, "fuelPressure": 0,  "coolantPressure": 0,    "lubOilTemperature": 6,  "coolantTemperature": 1},
    "COOLANT_OVERHEAT":  {"engineRpm": 0,    "lubOilPressure": 0,    "fuelPressure": 0,  "coolantPressure": -1.0, "lubOilTemperature": 8,  "coolantTemperature": 18},
    "COOLANT_LOSS":      {"engineRpm": 0,    "lubOilPressure": 0,    "fuelPressure": 0,  "coolantPressure": -2.5, "lubOilTemperature": 7,  "coolantTemperature": 20},
    "FUEL_STARVATION":   {"engineRpm": -300, "lubOilPressure": 0,    "fuelPressure": -9, "coolantPressure": 0,    "lubOilTemperature": 0,  "coolantTemperature": 0},
    "OVERSPEED":         {"engineRpm": 700,  "lubOilPressure": 0.5,  "fuelPressure": 3,  "coolantPressure": 0,    "lubOilTemperature": 5,  "coolantTemperature": 5},
    "OIL_DEGRADATION":   {"engineRpm": 0,    "lubOilPressure": -1.5, "fuelPressure": 0,  "coolantPressure": 0,    "lubOilTemperature": 10, "coolantTemperature": 2},
    "THERMOSTAT_STUCK":  {"engineRpm": 0,    "lubOilPressure": 0,    "fuelPressure": 0,  "coolantPressure": -1.0, "lubOilTemperature": -4, "coolantTemperature": -12},
}
FAULT_TYPES = list(FAULT_PROFILES)

PEAK_SEVERITY_RANGE = (0.80, 1.00)
# Measurement variance grows with severity: a degrading machine reads noisier.
NOISE_SEVERITY_GAIN = 2.0

STATUS_RUNNING, STATUS_STOPPED, STATUS_FAULT = 0, 1, 2
STATUS_NAMES = ["RUNNING", "STOPPED", "FAULT"]


# ─────────────────────────────────────────────────────────────────────────
# Small numeric helpers
# ─────────────────────────────────────────────────────────────────────────

def smoothstep(u: np.ndarray) -> np.ndarray:
    """C1-continuous 0->1 ramp (flat derivative at both ends)."""
    u = np.clip(u, 0.0, 1.0)
    return u * u * (3.0 - 2.0 * u)


def soft_floor(x: np.ndarray, k: float) -> np.ndarray:
    """
    Asymptotic floor at 0: returns ~x when x >> k, approaches 0 from above as
    x goes negative, and never actually reaches it. A hard clip would pin a
    dead-flat 0.0 across whole fault episodes -- a giveaway artifact that no
    real sensor produces. logaddexp keeps this stable for large |x|.
    """
    return k * np.logaddexp(0.0, x / k)


def ar1(a: float, eps: np.ndarray, x0: float, block: int = 2048) -> np.ndarray:
    """
    x[t] = a * x[t-1] + eps[t], evaluated blockwise so the recursion stays
    vectorised. Within a block, x[t] = a^(t+1)*x0 + a^t * sum_k eps[k]*a^-k;
    `block` is kept small enough that a^-block cannot overflow.
    """
    n = eps.shape[0]
    out = np.empty(n, dtype=np.float64)
    pw = a ** np.arange(block, dtype=np.float64)
    inv = 1.0 / pw
    for start in range(0, n, block):
        e = eps[start:start + block]
        m = e.shape[0]
        seg = np.cumsum(e * inv[:m]) * pw[:m] + x0 * pw[:m] * a
        out[start:start + m] = seg
        x0 = seg[-1]
    return out


def largest_remainder(weights: np.ndarray, total: int) -> np.ndarray:
    """Apportion `total` integer items across `weights`, preserving the sum."""
    exact = weights / weights.sum() * total
    base = np.floor(exact).astype(np.int64)
    for idx in np.argsort(-(exact - base))[: total - int(base.sum())]:
        base[idx] += 1
    return base


# ─────────────────────────────────────────────────────────────────────────
# Episode scheduling
# ─────────────────────────────────────────────────────────────────────────

def week_bounds(n_days: int) -> list[tuple[int, int, int]]:
    """(start_second, end_second, n_days) per calendar week of the corpus."""
    out = []
    for day in range(0, n_days, 7):
        days = min(7, n_days - day)
        out.append((day * SECONDS_PER_DAY,
                    (day + days) * SECONDS_PER_DAY,
                    days))
    return out


def allocate_weekly_counts(rng, weeks, total: int) -> tuple[np.ndarray, np.ndarray]:
    """
    Spread `total` episodes over the weeks, with N_BAD_WEEKS carrying roughly
    double the mean weekly count -- deferred maintenance and correlated
    failures cluster in real plants; the remaining weeks stay comparatively
    quiet. Week lengths are respected (the final week is short of 7 days).
    """
    n_weeks = len(weeks)
    days = np.array([w[2] for w in weeks], dtype=np.float64)
    mean_weekly = total / n_weeks

    bad = np.zeros(n_weeks, dtype=bool)
    bad[rng.choice(n_weeks, size=min(N_BAD_WEEKS, n_weeks), replace=False)] = True

    # Bad weeks: pinned at ~2x the mean weekly count (pro-rated by week length).
    # Quiet weeks: share whatever is left, proportional to their length.
    want = np.zeros(n_weeks, dtype=np.float64)
    want[bad] = 2.0 * mean_weekly * days[bad] / 7.0
    leftover = total - want[bad].sum()
    if leftover <= 0:
        raise RuntimeError("bad weeks would consume every episode; lower N_BAD_WEEKS")
    want[~bad] = leftover * days[~bad] / days[~bad].sum()

    return largest_remainder(want, total), bad


def assign_fault_types(rng, total: int) -> list[str]:
    """Floor of MIN_EPISODES_PER_TYPE per type, remainder drawn uniformly."""
    # The floor relaxes only for reduced-size smoke runs; the shipped corpus is
    # large enough to honour it in full.
    floor = min(MIN_EPISODES_PER_TYPE, total // len(FAULT_TYPES))
    pool = FAULT_TYPES * floor
    pool += list(rng.choice(FAULT_TYPES, size=total - len(pool)))
    rng.shuffle(pool)
    return pool


def schedule_faults(rng, n_days: int, total: int):
    """
    Lay episodes out week by week. Inside a week we reserve EPISODE_BUFFER_S at
    each edge and EPISODE_BUFFER_S between neighbours, then scatter the
    remaining slack randomly across the gaps. Reserving at both edges means
    episodes either side of a week boundary are automatically >= 2 * buffer
    apart, so the guarantee holds globally and not just within a week.
    """
    weeks = week_bounds(n_days)
    counts, bad = allocate_weekly_counts(rng, weeks, total)
    types = assign_fault_types(rng, total)

    episodes, cursor = [], 0
    for (w_start, w_end, _), n in zip(weeks, counts):
        if n == 0:
            continue
        kinds = types[cursor:cursor + n]
        cursor += n

        durations = np.array([
            rng.integers(*(FAST_ONSET_DURATION_S if k == FAST_ONSET_TYPE else FAULT_DURATION_S),
                         endpoint=True)
            for k in kinds
        ], dtype=np.int64)

        span = (w_end - w_start) - 2 * EPISODE_BUFFER_S
        slack = span - durations.sum() - (n - 1) * EPISODE_BUFFER_S
        if slack < 0:
            raise RuntimeError(f"week starting {w_start}s cannot hold {n} episodes")

        # Random split of the slack across the n+1 gaps (uniform cut points).
        cuts = np.sort(rng.random(n))
        gaps = np.diff(np.concatenate(([0.0], cuts, [1.0]))) * slack

        t = w_start + EPISODE_BUFFER_S
        for i, (kind, dur) in enumerate(zip(kinds, durations)):
            t += int(round(gaps[i]))
            episodes.append({
                "faultType": kind,
                "start": int(t),
                "end": int(t + dur),          # exclusive
                "duration": int(dur),
                "peak": float(rng.uniform(*PEAK_SEVERITY_RANGE)),
            })
            t += int(dur) + EPISODE_BUFFER_S

    episodes.sort(key=lambda e: e["start"])
    return episodes, bad


def schedule_stops(rng, n_days: int, blocked: np.ndarray):
    """
    A few shutdowns per week, placed by rejection sampling so they never land
    inside a fault episode's protective hour (that hour has to be normal
    RUNNING data) nor within an hour of another shutdown.
    """
    n = n_days * SECONDS_PER_DAY
    stops = []
    for w_start, w_end, _ in week_bounds(n_days):
        for _ in range(int(rng.integers(*STOPS_PER_WEEK, endpoint=True))):
            lo, hi = (STOP_LONG_S if rng.random() < STOP_LONG_PROB else STOP_SHORT_S)
            dur = int(rng.integers(lo, hi, endpoint=True))
            # The restart ramp and the thermal tail have to fit too.
            tail = dur + SPIN_UP_S + THERMAL_TAIL_S
            for _ in range(200):
                s = int(rng.integers(w_start, max(w_start + 1, w_end - tail)))
                if s + tail >= n:
                    continue
                if blocked[max(0, s - EPISODE_BUFFER_S):min(n, s + tail + EPISODE_BUFFER_S)].any():
                    continue
                blocked[max(0, s - EPISODE_BUFFER_S):min(n, s + tail + EPISODE_BUFFER_S)] = True
                stops.append({"start": s, "end": s + dur, "duration": dur})
                break
    stops.sort(key=lambda e: e["start"])
    return stops


# ─────────────────────────────────────────────────────────────────────────
# Latent state
# ─────────────────────────────────────────────────────────────────────────

def build_state(rng, n: int, episodes, stops, dtbl):
    """
    Materialise the per-second latent state shared by every metric: the load
    process, the energised gate, fault severity, the labels, and the two
    temperatures' continuously thermally-lagged baselines.
    """
    theta = 1.0 / LOAD_TAU_S
    sigma = LOAD_SIGMA * np.sqrt(2.0 * theta)
    eps = rng.standard_normal(n) * sigma + theta * LOAD_TARGET
    load = np.clip(ar1(1.0 - theta, eps, LOAD_TARGET), LOAD_MIN, LOAD_MAX)
    del eps

    gate = np.ones(n, dtype=np.float64)
    severity = np.zeros(n, dtype=np.float32)
    fault_code = np.full(n, -1, dtype=np.int8)
    status = np.full(n, STATUS_RUNNING, dtype=np.int8)

    for ep in episodes:
        s, e = ep["start"], ep["end"]
        u = (np.arange(1, e - s + 1, dtype=np.float64)) / ep["duration"]
        # FUEL_STARVATION is the fastest-onset mode: same smooth ramp, front-loaded.
        shape = smoothstep(np.sqrt(u) if ep["faultType"] == FAST_ONSET_TYPE else u)
        severity[s:e] = (ep["peak"] * shape).astype(np.float32)
        fault_code[s:e] = FAULT_TYPES.index(ep["faultType"])
        status[s:e] = STATUS_FAULT
        ep["peakSeverity"] = float(severity[s:e].max())

    # Shutdowns: gate 1 -> 0 over the coast-down, held at a dead 0, then a
    # 60 s ramp back. Load is pulled toward ~0.02 on the same shape, then
    # blended back into the free-running process.
    for st in stops:
        s, e = st["start"], st["end"]
        status[s:e] = STATUS_STOPPED

        k = min(SPIN_DOWN_S, e - s)
        down = 1.0 - smoothstep(np.arange(1, k + 1, dtype=np.float64) / SPIN_DOWN_S)
        gate[s:s + k] = down
        gate[s + k:e] = 0.0
        load[s:s + k] = LOAD_MIN + (load[s] - LOAD_MIN) * down
        load[s + k:e] = LOAD_MIN

        up = smoothstep(np.arange(1, SPIN_UP_S + 1, dtype=np.float64) / SPIN_UP_S)
        gate[e:e + SPIN_UP_S] = up
        load[e:e + SPIN_UP_S] = LOAD_MIN + (load[e:e + SPIN_UP_S] - LOAD_MIN) * up

    # Both temperatures continuously chase a load-and-fault-dependent target
    # via an AR(1) lag (see the module docstring's "Thermal lag" section) --
    # unlike the pump domain's motorTemp, this is not limited to shutdown
    # transitions; it applies for the whole timeline.
    codes_full = np.where(fault_code < 0, len(FAULT_TYPES), fault_code)
    sev_full = severity.astype(np.float64)
    lagged_base = {}
    for j, metric in enumerate(LAGGED_METRICS):
        col = METRICS.index(metric)
        target = LAG_BASE[metric] + LAG_SLOPE[metric] * load + sev_full * dtbl[codes_full, col]
        a = LAG_A[metric]
        eps_t = (1.0 - a) * target
        lagged_base[metric] = ar1(a, eps_t, target[0])

    return load, gate, severity, fault_code, status, lagged_base


# ─────────────────────────────────────────────────────────────────────────
# Metric synthesis + output
# ─────────────────────────────────────────────────────────────────────────

SCHEMA = pa.schema([
    ("timestamp", pa.timestamp("s", tz="UTC")),
    ("engineRpm", pa.float64()),
    ("lubOilPressure", pa.float64()),
    ("fuelPressure", pa.float64()),
    ("coolantPressure", pa.float64()),
    ("lubOilTemperature", pa.float64()),
    ("coolantTemperature", pa.float64()),
    ("status", pa.string()),
    ("faultType", pa.string()),
])


def delta_table() -> np.ndarray:
    """(len(FAULT_TYPES)+1, 6) lookup; the final row is the no-fault zero row."""
    tbl = np.zeros((len(FAULT_TYPES) + 1, len(METRICS)), dtype=np.float64)
    for i, kind in enumerate(FAULT_TYPES):
        for j, metric in enumerate(METRICS):
            tbl[i, j] = FAULT_PROFILES[kind][metric]
    return tbl


def build_day(rng, sl, load, gate, severity, fault_code, status, lagged_base, dtbl):
    L = load[sl]
    g = gate[sl]
    sev = severity[sl].astype(np.float64)
    codes = np.where(fault_code[sl] < 0, len(FAULT_TYPES), fault_code[sl])
    noise_scale = 1.0 + NOISE_SEVERITY_GAIN * sev
    is_stopped = status[sl] == STATUS_STOPPED

    cols = {}
    for j, metric in enumerate(METRICS):
        if metric in LAGGED_METRICS:
            value = lagged_base[metric][sl]
            off = OFF_VALUE[metric]
            value = off + g * (value - off)
        elif metric == "lubOilPressure":
            oil_load = 1.0 - (1.0 - L) ** 2
            value = OIL_PRESSURE_INTERCEPT + OIL_PRESSURE_SPAN * oil_load + sev * dtbl[codes, j]
            if metric in SOFT_FLOOR_K:
                value = soft_floor(value, SOFT_FLOOR_K[metric])
            off = OFF_VALUE[metric]
            value = off + g * (value - off)
        else:
            intercept, slope = BASE[metric]
            value = intercept + slope * L + sev * dtbl[codes, j]
            # Floor the energised reading BEFORE gating. Applied afterwards it
            # would lift a genuinely stopped engine off zero by k*ln2. Faults
            # never coincide with shutdowns (they are an hour apart), so the
            # floor still covers every negative excursion a fault delta can
            # produce.
            if metric in SOFT_FLOOR_K:
                value = soft_floor(value, SOFT_FLOOR_K[metric])
            off = OFF_VALUE[metric]
            value = off + g * (value - off)

        # Sensors keep dithering when the engine is off -- except engineRpm,
        # whose OFF_NOISE_FRACTION is 0 so a stationary crankshaft reads a
        # true zero.
        amp = np.maximum(g, OFF_NOISE_FRACTION[metric])
        value += rng.standard_normal(value.shape[0]) * NOISE_SD[metric] * noise_scale * amp

        lo, hi = RANGE[metric]
        value = np.round(np.clip(value, lo, hi), 2 if metric != "engineRpm" else 1)

        # engineRpm is only ever allowed to read a hard 0.0 while STOPPED.
        if metric == "engineRpm":
            value = np.where(is_stopped, value, np.maximum(value, 0.1))

        cols[metric] = value

    return cols, is_stopped


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS)
    ap.add_argument("--episodes", type=int, default=N_FAULT_EPISODES)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--out", type=Path, default=Path("data/engine-telemetry"))
    ap.add_argument("--manifest", type=Path,
                    default=Path("data/engine-telemetry-episodes.csv"))
    args = ap.parse_args()

    n = args.days * SECONDS_PER_DAY
    rng = np.random.default_rng(args.seed)

    print(f"seed={args.seed}  days={args.days}  rows={n:,}")

    episodes, bad_weeks = schedule_faults(rng, args.days, args.episodes)
    blocked = np.zeros(n, dtype=bool)
    for ep in episodes:
        blocked[max(0, ep["start"] - EPISODE_BUFFER_S):
                min(n, ep["end"] + EPISODE_BUFFER_S)] = True
    stops = schedule_stops(rng, args.days, blocked)
    del blocked

    print(f"  {len(episodes)} fault episodes, {len(stops)} shutdowns, "
          f"bad weeks: {[int(w) + 1 for w in np.flatnonzero(bad_weeks)]}")

    dtbl = delta_table()
    load, gate, severity, fault_code, status, lagged_base = build_state(
        rng, n, episodes, stops, dtbl)

    out = args.out
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    status_names = np.array(STATUS_NAMES, dtype=object)
    type_names = np.array(FAULT_TYPES + [None], dtype=object)
    base_epoch = int(START.timestamp())

    for day in range(args.days):
        sl = slice(day * SECONDS_PER_DAY, (day + 1) * SECONDS_PER_DAY)
        cols, _ = build_day(rng, sl, load, gate, severity, fault_code, status,
                            lagged_base, dtbl)

        codes = np.where(fault_code[sl] < 0, len(FAULT_TYPES), fault_code[sl])
        ts = base_epoch + np.arange(sl.start, sl.stop, dtype=np.int64)

        table = pa.Table.from_arrays([
            pa.array(ts, type=pa.timestamp("s", tz="UTC")),
            *[pa.array(cols[m]) for m in METRICS],
            pa.array(status_names[status[sl]], type=pa.string()),
            pa.array(type_names[codes], type=pa.string()),
        ], schema=SCHEMA)

        date = (START + timedelta(days=day)).strftime("%Y-%m-%d")
        part = out / f"date={date}"
        part.mkdir(parents=True, exist_ok=True)
        pq.write_table(
            table, part / "part-000.parquet",
            compression="zstd", compression_level=9,
            use_dictionary=["status", "faultType"],
            column_encoding={m: "BYTE_STREAM_SPLIT" for m in METRICS},
            version="2.6",
        )
        if (day + 1) % 15 == 0 or day == args.days - 1:
            print(f"  wrote {day + 1}/{args.days} days")

    # Companion manifest: one row per fault episode.
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    with args.manifest.open("w", encoding="utf-8") as fh:
        fh.write("episodeId,faultType,startTimestamp,endTimestamp,"
                 "durationSeconds,peakSeverity\n")
        for i, ep in enumerate(episodes, start=1):
            s = START + timedelta(seconds=ep["start"])
            e = START + timedelta(seconds=ep["end"] - 1)   # inclusive last row
            fh.write(f"EP{i:04d},{ep['faultType']},"
                     f"{s.strftime('%Y-%m-%dT%H:%M:%SZ')},"
                     f"{e.strftime('%Y-%m-%dT%H:%M:%SZ')},"
                     f"{ep['duration']},{ep['peakSeverity']:.4f}\n")

    meta = {
        "seed": args.seed,
        "rows": n,
        "startTimestamp": START.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "endTimestamp": (START + timedelta(seconds=n - 1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "faultEpisodes": len(episodes),
        "shutdowns": len(stops),
        "badWeeks": [int(w) + 1 for w in np.flatnonzero(bad_weeks)],
        "episodesPerType": {t: sum(e["faultType"] == t for e in episodes)
                            for t in FAULT_TYPES},
        "statusShare": {STATUS_NAMES[c]: float((status == c).mean())
                        for c in (STATUS_RUNNING, STATUS_STOPPED, STATUS_FAULT)},
    }
    (args.out.parent / "engine-telemetry-meta.json").write_text(
        json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
