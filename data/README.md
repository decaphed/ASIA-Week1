# Synthetic pump telemetry — pre-labeled training corpus

90 days of continuous 1 Hz telemetry from a single centrifugal pump driven by an
electric motor, generated for supervised predictive-maintenance training.

| | |
|---|---|
| **Random seed** | **`20260816`** — set in `scripts/generate_pump_telemetry.py` (`SEED`) |
| Rows | 7,776,000 (90 days × 86,400 s, no gaps, no duplicates) |
| Coverage | `2026-05-01T00:00:00Z` → `2026-07-29T23:59:59Z`, all timestamps UTC |
| Sampling | exactly 1 s, strictly increasing |
| Fault episodes | 180 across all 7 fault types (min 22 per type) |
| Shutdowns | 61 |
| Status mix | RUNNING 96.87%, FAULT 3.06%, STOPPED 0.07% |
| Size | 73 MB (zstd Parquet, 90 daily partitions) |

Regenerating with the same seed reproduces the corpus **bit-for-bit** (verified
by re-running and comparing file contents).

## Files

| Path | What it is |
|---|---|
| `pump-telemetry/date=YYYY-MM-DD/part-000.parquet` | the telemetry, Hive-partitioned by UTC day, sorted by timestamp ascending |
| `pump-telemetry-episodes.csv` | companion manifest, one row per fault episode |
| `pump-telemetry-sample.csv` | 3,284-row plain-CSV excerpt spanning one DRY_RUN episode, for eyeballing without a Parquet reader |
| `pump-telemetry-meta.json` | generation summary (seed, counts, bad weeks, per-type totals) |

```python
import pandas as pd
df = pd.read_parquet("data/pump-telemetry")            # all 90 days, ~1.2 GB in memory
day = pd.read_parquet("data/pump-telemetry/date=2026-05-14")   # one day
```

Parquet was chosen over a single CSV because the same corpus is ~700 MB as CSV.
Partitioning by day means a consumer can stream one day at a time; both scripts
here do exactly that and hold flat memory regardless of corpus size.

## Schema

| Column | Type | Unit | Range |
|---|---|---|---|
| `timestamp` | `timestamp[s, tz=UTC]` | — | 1 s apart, strictly increasing |
| `flowRate` | double | L/min | 0–500, 1 dp |
| `rpm` | double | rev/min | 0–5000, 1 dp |
| `vibration` | double | mm/s | 0–25, 1 dp |
| `suctionPressure` | double | bar | 0–10, 1 dp |
| `dischargePressure` | double | bar | 0–25, 1 dp |
| `motorTemp` | double | °C | 0–150, 1 dp |
| `status` | string | — | `RUNNING` \| `STOPPED` \| `FAULT` |
| `faultType` | string | — | one of the 7 types below, `null` unless `status = FAULT` |

Every metric carries exactly one decimal place, matching what real
instrumentation reports — there are no artefacts like `47.384729103`. The
ranges come from `pump-physics.yaml`, the repo's shared source of truth.

`timestamp` is a native Parquet UTC timestamp rather than a string: it is
smaller, sorts correctly, and every reader renders it as ISO 8601
(`2026-05-01T00:00:00Z`). The two CSV files use ISO 8601 strings directly.

The manifest carries `episodeId`, `faultType`, `startTimestamp`,
`endTimestamp` (inclusive — the last row that is still labelled FAULT),
`durationSeconds`, and `peakSeverity`.

## About the labels

This is a **pre-labeled training corpus**: `faultType` is ground truth known at
generation time, the equivalent of a domain expert's confirmed diagnosis. It is
*not* a recording of a raw live sensor feed — real pump instrumentation reports
readings and operational status, never a diagnosis. The repo's live simulator
(`node-red/flow.json`) deliberately withholds `faultType` for that reason. The
label is included here precisely because that is what makes the corpus usable
for supervised training.

## How the signal is built

**One latent load variable.** All six metrics are driven by a single hidden
"load" L ∈ [0.02, 1] — how hard the pump is working. L is an Ornstein-Uhlenbeck
process (a mean-reverting slow random walk, not white noise) pulled toward 0.5
with a ~10-minute time constant, so the metrics move together with real
momentum instead of jumping independently between seconds. Measured across the
RUNNING rows, every metric correlates with `flowRate` at |r| ≥ 0.99:

| vs flowRate | rpm | vibration | suctionPressure | dischargePressure | motorTemp |
|---|---|---|---|---|---|
| r | +0.999 | +0.990 | −0.992 | +0.998 | +0.992 |

At load L with no fault:

```
flowRate = 50 + L*250      suctionPressure   = 3 - L*2.5
rpm      = 1000 + L*2600   dischargePressure = 2 + L*10
vibration= 0.5 + L*4       motorTemp         = 20 + L*40
```

Independent per-metric measurement noise is added on top at roughly 0.1–0.3% of
full scale — instrumentation-grade, and small enough that the shared load
signal, not the noise, drives second-to-second movement. Typical 1 s change in
steady RUNNING: flowRate 1.9 L/min, rpm 15.9, motorTemp 0.28 °C.

**Faults.** 180 episodes, 10–40 minutes each (DRY_RUN 2–10 minutes, the
fastest-onset mode). Severity ramps smoothly from 0 to the episode's peak
(0.80–1.00) along a smoothstep curve, and the per-metric deviation is
`severity × delta`. Measurement variance scales with severity too (×3 at peak) —
a degrading machine reads noisier. No episode is ever a single-sample spike, and
every episode is fenced by at least one hour of normal RUNNING data on each
side.

Deltas at severity 1 are taken verbatim from `node-red/flow.json`'s
`FAULT_PROFILES`, the repo's single source of truth for fault signatures:

| type | flowRate | rpm | vibration | suctionP | dischargeP | motorTemp | dominant signal |
|---|---|---|---|---|---|---|---|
| THERMAL | −20 | −150 | +2 | 0 | −1 | **+45** | motor overheating |
| CAVITATION | **−110** | +50 | +5 | **−1.2** | −6 | +8 | suction/flow collapse |
| BEARING | −10 | −300 | **+9** | 0 | 0 | +15 | vibration |
| IMPELLER_WEAR | −60 | 0 | +4 | **+0.3** | −3 | +10 | flow/pressure drop at same rpm |
| SEAL_LEAK | −15 | 0 | +0.5 | 0 | **−4** | 0 | discharge pressure only |
| MISALIGNMENT | −5 | −50 | **+6** | 0 | −1 | +12 | vibration, milder than BEARING |
| DRY_RUN | **−180** | **+100** | +7 | **−2.5** | **−15** | +25 | most severe, fastest onset |

Two pairs are deliberately separable: IMPELLER_WEAR's suction pressure rises
while CAVITATION's collapses, and DRY_RUN's rpm rises (no fluid load resisting
the motor) while CAVITATION's barely moves. Measured mean over the final third
of each episode, against a RUNNING baseline of 173.3 / 2281.8 / 2.5 / 1.8 / 6.9
/ 39.7:

| type | flowRate | rpm | vibration | suctionP | dischargeP | motorTemp |
|---|---|---|---|---|---|---|
| BEARING | 171.5 | 2116.5 | 9.3 | 1.7 | 7.2 | 51.9 |
| CAVITATION | 83.8 | 2276.7 | 6.3 | 0.9 | 2.1 | 45.2 |
| DRY_RUN | 28.4 | 2357.1 | 8.3 | 0.1 | 0.1 | 60.6 |
| IMPELLER_WEAR | 127.3 | 2289.2 | 5.6 | 2.0 | 4.6 | 47.6 |
| MISALIGNMENT | 169.7 | 2245.7 | 6.9 | 1.8 | 6.2 | 48.5 |
| SEAL_LEAK | 148.5 | 2141.8 | 2.6 | 1.9 | 3.4 | 37.6 |
| THERMAL | 155.9 | 2142.0 | 3.8 | 1.8 | 6.1 | 71.2 |

**Clustering.** Weeks 1, 2 and 13 are "bad weeks" carrying 28 / 28 / 24
episodes against 10 in each quiet week — roughly double the 13.8/week mean,
reflecting deferred maintenance and correlated failures. The one-hour buffer
around each episode holds in bad weeks too; they pack in more separate
episodes, they do not crowd out the buffer.

**Shutdowns.** A few per week, 20 s to ~5 minutes. The shaft genuinely stops: a
12-second coast-down drives the pump off, so `rpm` reads a hard `0.0` — an
encoder on a stationary shaft reports true zero rather than dithering. Flow,
vibration and discharge pressure fall to zero; suction pressure *rises* to its
static no-flow value of 3 bar (no friction loss with no flow); `motorTemp`
coasts down through a first-order thermal lag rather than snapping to ambient,
because a motor has thermal mass — a 20-second stop barely cools it. On restart
everything ramps back up smoothly over 60 seconds. `rpm` is never exactly `0.0`
anywhere outside a STOPPED row.

## Known characteristics

- **Fault recovery is a step, by design.** Severity ramps up smoothly across an
  episode, but the deviation is removed the instant the episode ends, per spec —
  so the last FAULT row and the first RUNNING row after it can differ sharply.
  Onset is gradual; recovery is not. If you would rather have a smooth
  recovery, taper `severity` at the tail in `build_state()`.
- **Metrics floor asymptotically, not by clipping.** DRY_RUN drives flow and
  discharge pressure below zero in raw terms. Rather than clip a dead-flat
  `0.0` across whole episodes — an obviously synthetic artefact — a softplus
  floor lets them approach zero from above and keep varying. Values are still
  hard-clamped to the physical ranges as a final safety net.
- `faultType` is `null` on ~96.9% of rows. That is the specified encoding, not
  missing data; the metric columns have no nulls at all.
- Load is modelled as stationary around 0.5 with no diurnal or seasonal cycle,
  since the spec calls for a single mean-reverting process. Fault *episodes*
  cluster into bad weeks, but the underlying load does not trend over 90 days.

## Reproducing and checking

```bash
python3 scripts/generate_pump_telemetry.py     # ~13 s, writes everything under data/
python3 scripts/validate_pump_telemetry.py     # ~30 s, exits non-zero on any failure
```

The validator re-derives every invariant from the written files rather than
from the generator's in-memory state, so a bug in the generator cannot hide
behind a shared assumption. It checks timestamp continuity, ranges, 1-decimal
precision, the rpm-zero rule, label consistency, episode counts/durations/
per-type floors, the absence of isolated FAULT rows, the one-hour buffers,
adjacent-second continuity, bad-week clustering, and agreement between the
telemetry and the manifest. Both scripts need only `numpy` and `pyarrow`.
