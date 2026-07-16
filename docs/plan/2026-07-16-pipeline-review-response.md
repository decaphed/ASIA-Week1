# Pipeline Review Response Plan

Addresses reviewer comments on `Raw Sensor to Forecasting.docx` (sampling interval, windowing, interpolation, physics validation). Source: `server/preprocessing/{buffer,missing,validator,outlier}.js`, `server/services/{forecastService,trendService,driftService}.js`.

## Step 1 - Confirm actual OT sampling interval and cadence contract

Establish, with the OT/instrumentation team, the true delivery interval and jitter characteristics of the source system (once-per-second vs once-per-minute vs variable), and document it as the authoritative cadence contract that `buffer.js`, `missing.js`, `outlier.js`, and the three time-series services (`forecastService`, `trendService`, `driftService`) all currently assume to be ~1 Hz. This is a blocking prerequisite: every downstream constant (MAX_FILLABLE_GAP_SECONDS=10, WINDOW_SIZE=60, Hampel's 7-sample neighborhood, ETS/Mann-Kendall/drift window sizes expressed in minutes) is calibrated against this assumption and must be re-validated once the real cadence is known.

## Step 2 - Redesign windowing to event-time boundaries with late/duplicate/out-of-order handling

Implement timestamp-based, fixed event-time window boundaries in `server/preprocessing/buffer.js` to replace pure count-based closing (currently: window closes on the 60th push with no wall-clock check). Define and implement explicit policies for late-arriving records, duplicate records, and out-of-order records, so a window's sample count decouples from an implicit duration guarantee. Depends on Step 1's confirmed cadence.

## Step 3 - Define per-metric interpolation ceilings with operating-state transition guards

Replace the single uniform `MAX_FILLABLE_GAP_SECONDS = 10` in `server/preprocessing/missing.js` with per-metric ceilings validated separately for flowRate, rpm, vibration, suctionPressure, dischargePressure, and motorTemp, reflecting their different physical dynamics (temperature slow-changing vs. RPM/flow/pressure fast-changing vs. vibration transient-sensitive). Add a guard that suppresses interpolation across a detected start-up, shutdown, trip, fault, or operating-state transition instead of bridging it with a fabricated straight line, and stop blindly carrying `status` forward across gaps that span a transition.

## Step 4 - Redesign physics validation with tolerance bands, state awareness, and repair-routing classification

Extend `server/preprocessing/validator.js` with tolerance bands and operating-state-aware logic for the documented edge cases (discharge pressure approaching suction during stop/equalization, post-stop flow from inertia/drainage/backflow, non-zero RPM during coast-down, status/analogue arrival skew). Add a classifier that distinguishes invalid data caused by sensor/wiring/scaling/configuration/communication failure from valid measurements indicating genuine abnormal physical operation, and route only the former into `imputeInvalidRuns()`'s stats-facing repair path; the latter must be preserved unrepaired as abnormal-process evidence for PdM, fault diagnosis, and alarm analysis, consistent with the document's existing "annotate, never discard raw" principle.

## Step 5 - Audit downstream services and add regression coverage for the redesigned pipeline

Audit `quality.js`, `aggregation.js`, `precapFeatures.js`, `forecastService.js`, `trendService.js`, and `driftService.js` for assumptions inherited from the old count-based/uniform-interpolation/undifferentiated-physics design, and add regression tests covering: event-time window correctness under late/duplicate/out-of-order samples, per-metric interpolation ceiling enforcement, state-transition interpolation suppression, and correct routing of sensor-fault vs. abnormal-operation physics violations.
