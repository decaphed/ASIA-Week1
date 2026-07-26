# Predictive Maintenance AI System Architecture — Design Proposal

**Scope:** AI system architecture for Module 1 (Predictive Maintenance & Asset Management)
of the AI-Enabled Plant Management Platform described in `AI_Solution_Feature_Design.docx`.

**Prompted by:** reviewer feedback moving the project from feature design to AI system
design, with an explicit ask to justify the selected approach rather than only describe it.
This document does not select a machine learning algorithm. It defines the components an
industrial PdM system needs, how they interact, and — for every major decision — why that
decision and not a plausible alternative. Section 2 works through that reasoning directly,
including, at the category level, why the initial implementation of each component should
draw on traditional/classical machine learning rather than deep learning, and how the
architecture accommodates moving to deep learning later without pinning the design to one
specific algorithm now.

**Relationship to the platform document:** Module 1 is one of six modules; it is developed
in the most detail because pump sensor data is the data source available today, not because
it is architecturally separate from the rest of the platform. Every component below is
designed to be reused — the same anomaly-detection methodology extends to Module 4
(Plant-Wide Anomaly Detection), the same governance lifecycle (monitoring → verification →
retraining → validation → versioning) is the template the platform's other modules should
eventually follow, and Module 1's outputs (fault type, confidence, cost impact) are inputs
to Module 6 (Unified Plant Decision Support). Section 14 makes these integration points
explicit.

**Relationship to this project's existing code:** this is not a greenfield proposal. Parts
of this architecture are already implemented — a rule-based degradation/drift signal
(`server/services/driftService.js`, `forecastService.js`), physics-aware data preparation
that separates sensor faults from genuine process anomalies (`server/preprocessing/
faultClassifier.js`), and a walk-forward evaluation harness with an explicit promotion bar
(`server/preprocessing/evaluation/`, documented in `FAULT_PREDICTION_PLAN.md`). Where that
is true, this document says so and explains how the existing piece maps onto the
architecture, rather than proposing to replace it.

---

## 1. Overview of the Recommended Architecture

**Recommendation:** a layered pipeline of several purpose-built components — not one single
model — modeled on the ISO 13374 condition-monitoring reference architecture (Data
Acquisition → Data Manipulation → State Detection → Health Assessment → Prognostic
Assessment → Advisory Generation), extended with an explicit human-verification step and a
governance layer that manages how models are tested, replaced, and tracked over time. This
governance pattern follows how long-lived industrial deployments such as IBM Maximo Predict,
Siemens Senseye, and C3 AI Reliability operate in practice.

Concretely, the architecture has three groups of components:

1. **Detection core** — data preparation, feature engineering, an anomaly-detection
   component (semi-supervised, trained on normal operation), a known-fault classification
   component (supervised, trained only on verified fault exemplars), and a confidence
   estimation / arbitration layer that reconciles the two into one of three outcomes:
   *normal*, *known fault (type, confidence)*, or *unknown anomaly*.
2. **Human-in-the-loop learning loop** — a verification workbench where engineers confirm,
   reject, or relabel flagged segments, turning "unknown anomaly" into either a new
   confirmed exemplar of an existing fault type or the seed of a new fault class.
3. **Lifecycle governance** — continuous monitoring for drift and performance drop, a
   controlled retraining process that folds newly verified examples in without discarding
   what was already learned, a validation step every candidate model must pass before it can
   go live, and a version history that lets a bad update be reverted quickly.

Section 2 works through, step by step, why this decomposition — rather than a single model,
or anomaly detection alone, or a deep-learning-first approach — was selected, and why it is
the right level of complexity for a system that starts with three months of data and is
expected to run and grow for years.

---

## 2. Why This Architecture?

This section presents the reasoning before the recommendation, because the reviewer's core
ask was justification, not a list of components. It works through five questions in order:
whether a single supervised classifier is enough; whether anomaly detection alone is enough;
why combining both is the right balance; why the initial version of each component should
use traditional, interpretable machine learning rather than deep learning; and why this
specific decomposition is what lets the system grow safely for years rather than needing to
be redesigned as more data arrives.

### 2.1 Why a single supervised classifier is not enough

A single end-to-end classifier — feed sensor readings in, get a fault label out, with
"normal" as just another trained class — is the default instinct, and the natural starting
point for comparison.

**Why it looks attractive:** it is the simplest architecture to build, explain, and deploy —
one artifact to train, evaluate, and version — and it would perform well on whichever fault
classes already have solid historical coverage.

**Why it is not suitable here, on both counts the project cares about:**

- *Small dataset:* a model that must learn "normal" and every fault type as classes of one
  problem needs enough labeled examples of every class to be trustworthy. With three months
  of data and, for most fault types, only a handful of confirmed episodes, the classes the
  model is weakest at are exactly the ones a live plant needs it to get right — normal
  operation dominates the data, but the moments that matter are the rare fault classes with
  the least evidence behind them. The hardest part of the problem is decided by the least
  data.
- *Long-term deployment:* a classifier that has learned to treat "normal" as one of its own
  trained classes has no structural way to say "this doesn't look like anything I know." Over
  years of operation, as the plant's environment, product mix, or equipment ages, entirely
  new operating regimes will appear — not necessarily faults, just unfamiliar — and a
  closed-set model has no honest answer for them; it must assign every input to one of its
  existing classes. Given new operating conditions or degradation modes that were not in the
  original training data (an explicit requirement here), this means a closed-set classifier
  will confidently mislabel a novel condition as the nearest known class rather than flag it
  as novel. This is the exact failure mode the open-set recognition and hybrid
  anomaly-detection literature exists to address (e.g. DenseHybrid, arXiv:2207.02606; Qsco,
  arXiv:2405.16368) — plain classifier confidence is a documented poor proxy for detecting
  that something is out of distribution, so lowering a confidence threshold is not a
  substitute for an explicit "is this normal at all" signal.

**Conclusion:** a single supervised classifier is rejected not because it is a bad model, but
because no closed-set classifier — however accurate on its trained classes — can satisfy the
requirement to identify behavior that does not match any previously known fault.

### 2.2 Why anomaly detection alone is not enough

The opposite simplification is a single anomaly/novelty-detection layer: flag any deviation
from normal operation, without attempting to name what kind of fault it is.

**Why it looks attractive:** it needs the least data of any option (normal-operation data
alone, which this project already has in abundance), and it naturally handles novel
conditions, since it never assumes a closed set of fault types. Note that this is *not* a
small-dataset problem the way the single-classifier option is — anomaly detection is well
suited to limited data, which is exactly why it is retained as one half of the recommended
architecture (2.3). The limitation is one of usefulness and trust, not data volume.

**Why it is not suitable here:**

- It cannot deliver most of what the platform already promises once an issue is found. A
  specific maintenance recommendation, an urgency level, a cost comparison, and a priority
  ranking (Features 2-5 of this module) all depend on knowing *what kind* of problem was
  found, not just that one exists. "Something is unusual" is not actionable in the way "this
  is a bearing fault, act within the week, estimated cost of waiting $X" is.
- It discards the value of the fault history this project already has, and will keep
  accumulating. The historical dataset already contains confirmed thermal, cavitation, and
  bearing episodes with known outcomes; a well-understood, previously-confirmed fault would
  be flagged with the same generic "anomaly" signal as a fault type nobody has ever seen.
  That under-serves the common, already-solved case while adding no extra safety for the
  genuinely rare one — every alert looks the same regardless of how well understood or
  urgent it is, which reintroduces the alert-fatigue risk this module's own Feature 5 (Alert
  Prioritization) is explicitly designed to avoid.
- Over the platform's lifetime, as the verified fault catalog grows into dozens of confirmed
  types, an anomaly-only design would never convert that growing, verified knowledge into
  faster or more specific answers — it would treat year ten, with a rich confirmed fault
  history, exactly like day one. That wastes the entire point of building a
  human-verification loop (sections 7-8) in the first place.

**Conclusion:** anomaly detection alone is rejected not for lacking data efficiency — it has
plenty — but for being unable to use the fault knowledge this project already has and will
keep building, which the platform's other features already depend on.

### 2.3 Why a hybrid architecture is the right balance

Splitting the problem so that an anomaly detector — needing only normal-operation data,
available from day one — decides whether a segment is worth flagging at all, and a
classifier — needing verified fault data, and growing only as that data grows — decides what
a flagged segment matches *if* it resembles something already confirmed, means each component
is only ever asked to do the part of the job its available data actually supports. The two
components combine into exactly the three outcomes the requirements ask for: normal, known
fault (with a name and a confidence), and unknown anomaly.

This decomposition also pays off outside Module 1 itself: Module 4 (Plant-Wide Anomaly
Detection) needs exactly the same underlying capability — deviation-from-normal detection —
just applied across assets and process signals instead of within one asset's channels. If
novelty detection were a private detail buried inside one fault classifier, Module 4 could
not reuse it, and the platform would end up maintaining two divergent anomaly-detection
implementations. Making it an explicit, shared component means Module 1 and Module 4 share
one methodology at different scopes.

It is also not a novel proposal for this project to invent: Siemens' published Senseye
architecture separates anomaly detection, pattern matching/classification, degradation
forecasting, and advisory generation as distinct stages rather than one model call; IBM
Maximo Predict documents deployment, monitoring, and retraining as decoupled lifecycle
phases with technician feedback built in as a first-class mechanism. This project's own
codebase has already converged on the same boundary independently:
`driftService.js`/`forecastService.js` already provide a no-training-required, rule-based
degradation signal (Feature 1) that is completely independent of the not-yet-built supervised
classifier reserved for a later phase (Feature 3), and the evaluation harness in
`FAULT_PREDICTION_PLAN.md` already requires any future classifier to beat that independent
baseline — a pattern that only makes sense if "detect something is wrong" and "say what it
is" are already being treated as separate, separately-evaluated concerns. This document
formalizes that existing boundary rather than introducing a new one.

### 2.4 Why traditional machine learning, not deep learning, is the right starting point

Large neural-network models — especially architectures built for sequential or time-series
data — are the reflexive choice for sensor-based fault detection in research settings, but
they are not the right starting point for this specific deployment. This is a judgment about
this project's current constraints, not a general dismissal of deep learning:

- **Data volume.** Deep models typically need labeled examples in the thousands to millions
  to generalize rather than memorize. This project has three months of data and, for most
  fault types, only a handful of confirmed episodes — the same small-data / imbalanced-sample
  problem the industrial few-shot fault-diagnosis literature documents as a standing
  challenge for deep approaches. Applied to a dataset this size, a deep model is far more
  likely to learn the specific quirks of its few examples (including artifacts of whatever
  system generated the data) than a fault signature that generalizes to future cases — the
  opposite of "detects known faults reliably."
- **Auditability and trust.** The audience deciding whether to trust this system's alerts is
  plant engineers and managers, not machine learning specialists — the same audience Feature
  4 (Cost Impact Assessment) already insists on traceable, documented assumptions for, rather
  than opaque figures. Traditional statistical and shallow-model approaches are far easier to
  inspect, explain, and check against physical intuition than a deep network's internal
  representations, which matters most early in a deployment, while trust is still being
  established.
- **Validation feasibility.** The validation approach this design requires (section 12) is
  already working with very little held-out data per fault class; a model with many more
  parameters needs proportionally more held-out data to produce a trustworthy validation
  result. Simpler models can be validated meaningfully on the amount of data this project can
  actually spare for evaluation today.
- **Operational overhead.** Deep learning typically implies heavier training infrastructure
  and more specialized upkeep than the traditional-ML tooling this project's existing
  pipeline is already built around — overhead not justified before enough data exists to make
  use of it.

None of this rules deep learning out permanently — see 2.5.

### 2.5 Why this architecture can evolve as more data becomes available

Every component in this architecture is defined by *what it does and what it is trained on*,
not by a specific algorithm — that is the point of designing an architecture rather than
picking a model. The anomaly detector's job ("characterize normal operation, score deviation
from it") and the classifier's job ("distinguish among verified fault types") stay the same
whether implemented today with a simple statistical or distance-based approach, or years from
now with a more data-hungry model once enough verified fault history has accumulated to
support one safely. Moving a component to a more complex model later only ever requires that
candidate to clear the same validation gate (section 12) every other candidate already has
to clear — it does not require redesigning the pipeline, the human-verification loop, or the
governance layer around it. This is the concrete sense in which what is being designed and
delivered now is the architecture, not an algorithm choice — and it is why the four
constraints above (data volume, auditability, validation feasibility, operational overhead)
are treated as reasons to *start* with traditional ML, not reasons to rule anything out for
good.

---

## 3. High-Level Architecture / Workflow

```
                         HISTORICAL DATA (~3 months, incomplete fault coverage)
                                            |
                                            v
        ┌───────────────────────────────────────────────────────────────┐
        │ [1] DATA PREPARATION                                          │
        │  ingestion, physics validation, sensor-fault vs. process-     │
        │  anomaly routing, gap-aware imputation, raw-signal preserved  │
        └───────────────────────────────────────────────────────────────┘
                                            |
                                            v
        ┌───────────────────────────────────────────────────────────────┐
        │ [2] FEATURE ENGINEERING                                       │
        │  generic per-channel-role features (statistical, trend,      │
        │  drift), per-asset / per-asset-class baselining               │
        └───────────────────────────────────────────────────────────────┘
                                            |
                    ┌───────────────────────┴───────────────────────┐
                    v                                                 v
    ┌───────────────────────────────┐             ┌───────────────────────────────┐
    │ [3a] ANOMALY / NOVELTY         │             │ [3b] KNOWN-FAULT              │
    │      DETECTION                │             │      CLASSIFICATION           │
    │  semi-supervised, trained on   │  gates -->  │  supervised, multi-class,     │
    │  normal operation only         │             │  trained only on verified     │
    │  (asset-agnostic, per class)   │             │  fault exemplars               │
    └───────────────────────────────┘             └───────────────────────────────┘
                    └───────────────────────┬───────────────────────┘
                                            v
        ┌───────────────────────────────────────────────────────────────┐
        │ [4] CONFIDENCE ESTIMATION & ARBITRATION                       │
        │  calibrated decision policy →  NORMAL | KNOWN FAULT (type,    │
        │  confidence) | UNKNOWN ANOMALY                                 │
        └───────────────────────────────────────────────────────────────┘
              |                       |                        |
              v                       v                        v
          no alert          Features 1-5 alert /       routed to review
                             recommendation / cost
                             pipeline (existing)
                                                                |
                                                                v
        ┌───────────────────────────────────────────────────────────────┐
        │ [5] HUMAN VERIFICATION & LABELING WORKBENCH                   │
        │  engineer confirms / rejects / relabels via work order;       │
        │  verified segment → exemplar store (new label or new class)  │
        └───────────────────────────────────────────────────────────────┘
                                            |
                                            v
        ┌───────────────────────────────────────────────────────────────┐
        │ [6] MODEL MONITORING (always-on, alert-only)                  │
        │  data drift (input distributions) + concept drift (input→     │
        │  outcome relationship) + live performance vs. baseline         │
        └───────────────────────────────────────────────────────────────┘
                                            |
                                            v
        ┌───────────────────────────────────────────────────────────────┐
        │ [7] RETRAINING                                                │
        │  periodic / triggered; trained on ALL verified examples so    │
        │  far (old fault types + new), not only the newest ones        │
        └───────────────────────────────────────────────────────────────┘
                                            |
                                            v
        ┌───────────────────────────────────────────────────────────────┐
        │ [8] VALIDATION GATE                                           │
        │  walk-forward evaluation; regression check across EVERY       │
        │  prior class; must beat the model currently in use             │
        └───────────────────────────────────────────────────────────────┘
                                            |
                                            v
        ┌───────────────────────────────────────────────────────────────┐
        │ [9] VERSION HISTORY                                           │
        │  every validated version kept, with its training data and     │
        │  evaluation results, so any past version can be restored       │
        └───────────────────────────────────────────────────────────────┘
                                            |
                                            v
        ┌───────────────────────────────────────────────────────────────┐
        │ [10] STAGED ROLLOUT & ROLLBACK                                │
        │  new model tested on live data before it takes over; instant  │
        │  revert to the previous version if something looks wrong      │
        └───────────────────────────────────────────────────────────────┘
                                            |
                                (feeds back into [3a]/[3b] serving)

        Shared outward:
          [3a] methodology  → reused, cross-asset, by Module 4 (Plant-Wide Anomaly Detection)
          alert/cost output → consumed by Module 6 (Unified Plant Decision Support)
          [6]-[10] lifecycle → template other modules' own future models should follow
```

---

## 4. Major AI Components and Their Responsibilities

| Component | Responsibility | Learns from | Data regime it is suited to |
|---|---|---|---|
| **Data Preparation** | Ingest raw sensor streams; validate against physical plausibility; distinguish sensor/instrumentation faults from genuine abnormal process behavior; impute only where physically justified; preserve raw signal alongside any smoothed copy | No learning — deterministic, physics-informed rules | Any volume, day one |
| **Feature Engineering** | Convert prepared readings into a generic, asset-agnostic feature set per "channel role" (e.g. primary vibration, process temperature, flow, discharge/suction pressure, rotational speed) plus derived trend/drift features | No learning — deterministic transforms, some per-asset baselining | Any volume, day one |
| **Anomaly / Novelty Detection** | Score how far current behavior deviates from established normal operation; flag whether a deviation resembles any known fault signature or is unlike anything seen | Semi-supervised — trained on normal-operation segments only | Weeks of normal operation per asset/class |
| **Known-Fault Classification** | For segments already flagged abnormal, identify which known fault type is present, with a class-conditional confidence | Supervised — trained only on verified fault exemplars, incrementally | Grows with verified exemplar count; explicitly gated on a minimum episode count per class |
| **Confidence Estimation & Arbitration** | Combine the two upstream signals into one calibrated decision: normal / known fault (with confidence) / unknown anomaly; sets the operating threshold as a cost trade-off, not an arbitrary probability cutoff | Calibration only, not a predictive model of its own | As soon as the two upstream components exist |
| **Human Verification & Labeling Workbench** | Surface flagged segments to engineers/technicians tied to a work order; capture confirm / reject / relabel / new-class decisions | N/A — the mechanism by which humans supply new ground truth | Continuous, throughout the platform's life |
| **Model Monitoring** | Continuously track input-distribution drift, concept drift, and live precision/recall/calibration against the standing rule-based baseline; raise retraining triggers | Statistical monitoring, not predictive | Continuous, always-on |
| **Retraining** | Build the next candidate model from all verified examples collected so far — old fault types and new ones together — so new knowledge doesn't crowd out old | Batch, periodic/triggered, never continuous in-place updates | Triggered by schedule or accumulated verified examples |
| **Validation** | Walk-forward (chronological) evaluation of every candidate model against every known class, old and new, plus false-positive rate on confirmed-normal holdout | N/A — evaluation, not learning | Every retraining run, before promotion |
| **Version History** | Keep every validated model version, its training data, and its evaluation results, so a specific past version can always be identified and restored | N/A | Every validated version |
| **Deployment / Rollout** | Test a new model on live data before it takes over any real alert; switch over only once its live behavior matches what validation predicted; revert instantly to the previous version if it doesn't | N/A | Every promotion event |

---

## 5. End-to-End Data Lifecycle

1. **Historical baseline (today).** ~3 months of asset-performance data, physics-validated
   and feature-engineered as described in sections 6-7, containing a partial catalog of
   known fault types. This trains the *initial* anomaly detector (on the normal-operation
   majority of the data) and a *first-cut* known-fault classifier for whichever fault types
   already have enough confirmed episodes (the project's own evaluation harness sets that
   bar at ~100-200 onset episodes; classes below that threshold are not trained yet, only
   monitored for accumulation).
2. **Live scoring.** New readings flow through Data Preparation → Feature Engineering →
   Anomaly Detection → (if abnormal) Known-Fault Classification → Confidence Estimation,
   producing one of: no alert, a known-fault alert (feeding the existing Features 1-5
   diagnosis/recommendation/cost/prioritization pipeline), or an unknown-anomaly alert.
3. **Human verification.** Unknown-anomaly alerts and low-confidence known-fault calls are
   queued for an engineer, tied to the relevant work order, the same pattern IBM Maximo
   Predict documents ("technician feedback mechanism directly in work orders"). The
   engineer's verdict — confirmed known fault, confirmed new fault type, or false alarm —
   becomes ground truth.
4. **Exemplar accumulation.** Verified segments join a curated exemplar store, tagged by
   fault class (existing or newly created). This store, not just "new data since last
   training," is what future retraining draws on — this is what makes safe incremental
   learning possible (sections 9-10).
5. **Monitoring.** Independently of any retraining, drift and live-performance monitoring
   run continuously and only ever raise a signal — they never change the deployed model
   themselves.
6. **Retraining.** On a schedule or trigger (section 9), a candidate model is retrained using
   the full accumulated set of verified examples — old fault types and new ones together —
   so it does not lose what it already knew while learning something new.
7. **Validation.** The candidate is evaluated walk-forward against every class the model
   currently in use knows, plus any new class, and against confirmed-normal holdout for false
   positives. It must clear the bar on all of them, not just the new class.
8. **Versioning and deployment.** A model that passes validation is recorded as a new
   version and tested on live data alongside the model currently in use before it is allowed
   to drive any real alert; it only takes over once its live performance is confirmed to
   match what validation predicted.
9. **Continuous improvement.** The loop returns to step 2 with a (possibly) updated model,
   and the exemplar store keeps growing from step 3 onward — this is how the platform
   improves over its lifetime without ever bypassing steps 5-8.

---

## 6. Detecting Known Faults

Known-fault detection is deliberately the *second* stage of the detection core, not the
first. The anomaly detector (3a) has already established that a segment deviates from
normal operation; the classifier's only job is to decide, among the fault types it has
been given verified examples of, which one this looks like — and to say so with a
calibrated confidence rather than a bare label.

Gating the classifier behind the anomaly detector matters for a data-scarcity reason
specific to this project: a classifier that must also learn to recognize "normal" alongside
every fault type needs far more data and a harder decision boundary than one that is only
ever asked to discriminate among a handful of already-abnormal fault types. With three
months of data and an incomplete fault catalog, that difference is the gap between a
classifier that is usable now and one that isn't ready for a long time. This mirrors the
project's own existing design choice: the not-yet-built classifier work in
`FAULT_PREDICTION_PLAN.md` Phase 4 is explicitly scoped to start once ~100-200 fault onset
episodes exist — a bar that is achievable much sooner if the classifier only has to
discriminate among faults, rather than fault-vs-normal-vs-fault simultaneously.

The classifier operates over the same generic, channel-role feature set as everything else
(section 7), so "known fault" here means known fault *signature* — a physically
characterized pattern across channel roles (e.g. a channel-role combination consistent with
bearing wear: rising vibration amplitude with a co-trending speed instability) — not a
hardcoded, asset-specific rule. Adding a new asset type does not require a new classifier
architecture, only enough verified exemplars of that asset's fault signatures.

This is also why the approach suits long-term deployment: a fault class only has to cross
its confirmed-exemplar threshold once to become classifiable, and from then on it is simply
carried forward and reinforced by the normal retraining cycle (sections 9-10). Classification
quality improves monotonically as more faults are verified over the platform's life, without
requiring any change to the pipeline itself.

## 7. Handling Previously Unseen Faults (Unknown Fault Types)

Recognizing conditions the historical data never contained is one of the two or three
hardest requirements this project sets, and it is treated as its own section here because it
is easy to get wrong quietly — by producing confident, wrong answers rather than an honest
"I don't recognize this."

### 7.1 Why unknown faults are a major industrial challenge

Real industrial equipment operates for years or decades, long past the window covered by any
initial training dataset. Over that time, wear mechanisms interact in ways not previously
observed, plants change process parameters, ambient conditions shift across seasons,
equipment gets repaired with different parts than the original, and, occasionally, a failure
mode occurs for the first time anywhere in the fleet. A training dataset — however carefully
collected — is a record of what has already happened, not a guarantee of what can happen.
This project's three months of data make that an immediate, explicit issue rather than a
distant hypothetical: it already only contains examples of a subset of known fault types,
and there is no reason to expect the real fault catalog to stop growing at three months, or
ever. Treating the historical dataset as a complete catalog of everything the system will
ever need to recognize is one of the most common ways predictive maintenance systems fail
quietly in production — not by giving wrong answers, but by giving confident answers to
questions they were never actually equipped to answer.

### 7.2 Why supervised models alone cannot recognize unknown failures

A supervised multi-class model, by construction, must assign every input to one of its
trained classes — there is no output slot for "a fault type I have never seen." Given new
operating conditions or degradation modes never present in the original training data, a
closed-set classifier will confidently mislabel a novel fault as the nearest known class
rather than flag it as novel, and its confidence score is not a reliable substitute for an
honest novelty signal (section 2.1). This is the exact gap the open-set recognition
literature addresses by treating "is this abnormal at all" and "which known type is this" as
separate questions.

### 7.3 How anomaly detection complements fault classification

The anomaly/novelty detector (3a) is trained in a semi-supervised regime, exclusively on
segments confirmed to be normal operation — so it never needs an example of a fault to
recognize that current behavior does not resemble normal behavior. This is exactly the
property this project's small, incomplete dataset can support today: normal operation is the
large majority of any three months of industrial data, and this kind of deviation modeling
scales down to weeks, not months, of examples per asset.

When the detector flags a segment as abnormal, arbitration (component 4) asks a second
question: does this abnormality's feature signature sit close to any known fault class's
learned signature (routed to classification), or is it unlike anything the system has
confirmed exemplars for (surfaced as an *unknown anomaly*, not forced into the nearest known
label)? This is what prevents the system from quietly mislabeling a genuinely new degradation
mode as a familiar one.

An unknown anomaly is not, by itself, a diagnosis — the architecture does not claim to name a
fault it has never been shown an example of. It is a well-calibrated "something here does not
match anything I know, an expert should look" signal — the gap between automated detection
and automated diagnosis that human verification exists to close.

### 7.4 How engineers verify and label new fault cases

Every unknown-anomaly alert is routed to a verification workbench tied to the plant's
existing maintenance work-order flow, so an engineer resolves it as part of the inspection or
repair work already being done, not as a separate labeling chore. The engineer's verdict is
one of: confirmed known fault (strengthens an existing class), confirmed new fault type
(seeds a brand-new class), or false alarm (a hard-negative example that improves future
precision). Section 8 covers this workflow in full.

### 7.5 How newly verified faults become part of future training data

Every verdict, together with the underlying segment data, joins a curated exemplar store.
Future retraining draws on that full, growing store — not only on data collected since the
last retraining run — which is what lets a brand-new class, seeded by a single confirmed
case, be trained into the classifier once enough further examples of it accumulate. Sections
9 and 10 cover how this is done without eroding what the model already knows.

### 7.6 Why this supports continuous improvement without assuming every fault already exists

Taken together, 7.1-7.5 mean the fault catalog is treated as something that grows by design,
not something fixed at deployment. The system's ability to *name* faults improves every time
an engineer verifies a new case, while its ability to *notice that something is wrong* never
depended on that catalog being complete in the first place. This is what makes "the platform
is expected to improve continuously throughout its lifetime" and "new fault types may appear
that were never present in the original training data" compatible requirements rather than a
contradiction: novelty detection carries the second requirement from day one, and the
verification-and-retraining loop is what lets continuous improvement apply to the growing,
not-yet-known part of the fault catalog just as much as to the known part.

## 8. How Engineers Verify and Label New Faults

Every unknown-anomaly alert and every low-confidence known-fault call is routed to a
verification workbench, tied to the same work-order/maintenance-event mechanism the
platform already uses for Feature 2 (Maintenance Event Recommendation), rather than a
separate disconnected review tool. This mirrors IBM Maximo Predict's documented pattern of
adding technician feedback directly into the work-order flow — verification is folded into
work engineers are doing anyway (inspecting, repairing, closing out the event), not an
additional data-labeling chore layered on top.

An engineer reviewing a flagged segment has three possible verdicts:

- **Confirmed known fault** — the segment is relabeled/confirmed as an existing fault
  class; it strengthens that class's exemplar count.
- **Confirmed new fault type** — the engineer determines this is a genuinely new failure
  mode; it seeds a brand-new fault class with its first verified exemplar(s). (A single
  new class needs to accumulate more confirmed examples, via the same route, before a
  classifier can learn to recognize it reliably — the workbench records it immediately,
  training catches up on the next retraining cycle once enough exemplars exist.)
- **False alarm** — the segment is confirmed as within-normal variation the detector
  mis-flagged; it becomes a hard-negative example that improves the anomaly detector's
  precision on the next retraining cycle, directly counteracting the alert-fatigue risk the
  platform document already identifies as a threat to adoption (Feature 5).

Every verdict is captured with the underlying raw and prepared segment data, not just a
label, so the exemplar store used for retraining always contains full, physically-grounded
evidence rather than a bare tag.

## 9. How the System Safely Incorporates New Knowledge

**Rejected approach: continuous/online learning** (updating the deployed model in place, on
every new verified example, as it arrives). This is unsafe for this deployment for three
concrete reasons: (1) there is no natural point at which to evaluate a continuously-changing
model before it affects live alerts — validation would have to happen *after* the model has
already changed behavior in production; (2) a single ambiguous or mislabeled engineer
verification could silently degrade the live model with no gate to catch it; (3) reverting a
model whose parameters are constantly being updated is operationally undefined — there is no
discrete "version" to return to. Industrial practice supports treating model updates as
planned, evaluated events instead: IBM's own documented experience shows drift (from a plant
process change) being handled through a deliberate, planned retraining and threshold
adjustment, not an automatic in-place update — "model drift is inevitable and retraining is a
planned activity, not a crisis."

**Recommended approach: periodic, gated retraining that includes everything learned so
far.** Retraining runs on a schedule (e.g. monthly, or whatever cadence matches how quickly
the exemplar store meaningfully grows) or is triggered early by monitoring (section 11) or by
a fault class crossing its minimum-exemplar threshold. Each run:

- Trains on the **full curated exemplar store** — every previously confirmed example of
  every class, plus new ones — not just data collected since the last run. Rehearsing old
  examples alongside new ones like this (sometimes called replay-based or rehearsal-based
  learning) is one of the standard, well-validated ways to keep a model from losing older
  knowledge while it learns something new, and it is the simplest of the common approaches to
  validate and explain to a non-ML stakeholder — "the model is always trained on everything
  it has ever been shown to be true" is an easy invariant to audit.
- Where the specific model chosen for a component has a structure that supports it (for
  instance, a shared representation with separate, addable decision logic per class), a new
  fault class can also be added in a way that structurally isolates it from what was already
  learned — touching only that class's own piece rather than the whole model. This is
  optional and depends on which model implements the component (section 2.5); the mandatory
  safeguard, independent of that choice, is the regression check in section 10.
- The candidate is never deployed directly; it goes through the validation gate (section 12)
  and staged rollout (section 13) before it can affect a live alert.

**Why this fits both ends of the project's lifecycle:** early on, while the verified-exemplar
store is still small, this kind of batch retraining is cheap and simple to run occasionally,
rather than needing an always-on training process reacting to every single new label —
appropriate when only a handful of new examples arrive between engineer verifications. Later,
once the store has grown across years of verified operation, the same scheduled, gated
process scales by retraining on the accumulated store rather than by changing the underlying
approach. Continuous online learning, by contrast, would need to solve the hard version of
the evaluation-and-rollback problem (sections 12-13) from day one, for a benefit — instant
reaction to a single new example — this deployment does not need enough to accept that risk.

This satisfies the explicit requirement that "introducing new knowledge must not reduce
performance on previously learned operating conditions" by making that check a mandatory,
mechanical gate (section 12), rather than a hope.

## 10. Preventing Catastrophic Forgetting

Catastrophic forgetting — a model's performance on previously learned cases collapsing once
it is sequentially trained on new ones — is the central, well-documented failure mode of
naive sequential learning, and it is the single biggest risk in a system expected to add new
fault classes for years. Three complementary safeguards are recommended, matched to what this
deployment can practically operate:

1. **Rehearsal via the curated exemplar store (primary mechanism).** As above — every
   retraining run mixes old and new verified exemplars. This requires nothing beyond the
   human verification workbench already producing labeled examples with their underlying
   data retained, which this architecture already needs for other reasons (section 8).
2. **Structural isolation for new classes, where the chosen model supports it (secondary).**
   Keeping a new class's own parameters separate from previously-learned classes, when the
   underlying model's structure allows it, bounds the effect of adding a class to that
   class's own piece.
3. **A mandatory check across every class — the actual enforcement mechanism.** Rehearsal
   and structural isolation reduce the *likelihood* of forgetting; they do not by themselves
   guarantee it didn't happen. The validation gate (section 12) is what actually enforces the
   requirement: every candidate model is evaluated on held-out examples of **every**
   previously known fault class, not only the new one, and any regression below the model
   currently in use blocks promotion outright. This is the difference between "we used a
   technique believed to reduce forgetting" and "we verified, for this specific model, that
   forgetting did not occur" — only the latter is a claim this design is willing to make about
   a system whose mistakes carry real maintenance cost.

This is a deliberately conservative choice, and it fits both ends of the project's lifecycle:
early on, with only a handful of verified examples per class, rehearsing the whole exemplar
store is cheap because the store itself is small. Later, once years of verified operation have
built up a much larger store, retraining can draw on a representative, curated selection from
it rather than everything ever collected, keeping the computational and storage cost bounded
as the platform matures — the discipline scales without needing to change. More elaborate
continual-learning techniques exist in the research literature (e.g. for federated or
streaming settings with storage or privacy constraints), but an industrial deployment with a
governed retraining cadence and a maintainable exemplar store can afford this simpler,
easier-to-verify combination of rehearsal plus a mandatory regression check over schemes
whose forgetting-prevention guarantees are harder to demonstrate to a plant engineering
stakeholder.

## 11. Monitoring and Managing Model Drift

Two distinct phenomena are monitored, because they call for different responses:

- **Data drift** — the distribution of incoming sensor readings shifts (a recalibrated
  sensor, a new ambient condition, a process change) even though the fault-relevant
  relationships haven't changed. This project already has a working building block for this:
  `driftService.js`'s reference-vs-recent statistical comparison. Generalizing this
  per-channel-role check to run continuously against every deployed model's expected input
  distribution is the natural extension.
- **Concept drift** — the relationship between inputs and true outcomes changes (the same
  vibration signature now means something different because, say, a plant changed its
  cooling-water treatment — IBM's own documented example of exactly this happening to a
  deployed pump bearing model). This is detected by tracking live precision/recall/
  calibration against confirmed outcomes over time, using the same metrics this project's
  existing evaluation harness (`server/preprocessing/evaluation/metrics.js`) already computes
  offline — applied continuously, in production, against the model currently in use.

Early in the platform's life, with only three months of history, the baseline this
comparison runs against is itself thin — drift thresholds should start wide and tolerant, and
tighten as more operating history (ideally spanning multiple seasons and production cycles)
accumulates. This is a deliberate, temporary looseness, not a gap in the design: a system that
overreacts to drift signals when it barely has a baseline to compare against would generate
exactly the false-alarm noise Feature 5 is designed to prevent. Over years of operation, as
the baseline grows and comes to reflect genuine seasonal and operational variation, the same
monitoring becomes more precise without needing to be redesigned.

Critically, **monitoring only ever raises a signal; it never changes the deployed model
itself.** This mirrors the separation already argued in section 9 between detecting a
problem and acting on it: drift detection should be cheap, continuous, and always-on;
correcting for drift (retraining, revalidating, redeploying) should be deliberate and gated.
Collapsing the two — auto-retraining the instant drift crosses a threshold — reintroduces
exactly the "no evaluation gate before it affects production" risk section 9 rejects for
online learning.

## 12. Model Validation Before Deployment

Every candidate model, whatever produced it, must clear the same validation gate before it
can be deployed:

- **Chronological (walk-forward) evaluation only — never random or k-fold splitting.** This
  project has already established, with data (motorTemp lag-1 autocorrelation ~0.9), why a
  random split leaks: adjacent readings are highly autocorrelated, so a random split lets a
  model "cheat" by interpolating between near-duplicate neighboring samples, producing a
  reported accuracy that does not reflect real predictive skill. That finding is not specific
  to the current phase of this project — it is a structural property of time-series sensor
  data, and this architecture makes chronological, episode-boundary splitting a standing rule
  for every future model, not a one-off fix. It also matters for the small-dataset
  constraint: with only three months of data to spare, this discipline is what makes sure
  every available example is used for either training or evaluation, never silently both,
  which is the only way to get a trustworthy read on a model's real skill when data is this
  limited.
- **Evaluated against every known fault class, old and new — never against the new class
  alone.** This is the mechanical enforcement of the no-regression requirement (sections 9
  and 10): a candidate that improves on a new fault type but degrades recall on a
  previously-learned one fails validation, full stop.
- **Evaluated against confirmed-normal holdout for false-positive rate**, not only true
  positive rate on faults — a model that becomes more sensitive at the cost of flooding
  operators with false alarms fails on the platform's own stated concern about alert fatigue
  undermining adoption (Feature 5).
- **The bar is relative, not absolute.** A candidate must beat the model *currently in use*
  (and, where relevant, the standing rule-based baseline this project's evaluation harness
  already computes) at the same operating lead-time and cost point — never an arbitrary fixed
  accuracy number, and never a bare probability cutoff. This follows the same cost-based
  reasoning this project's own plan already applies to alerting (its plan to alert on
  expected-cost comparison rather than a 0.5 probability cutoff): the model that should ship
  is the one that demonstrably reduces expected cost/risk compared to what's running today,
  not the one with the highest raw score on an arbitrary metric.

## 13. Managing Model Versions and Recovering from a Bad Update

Every model that passes validation is kept, not just deployed — each version is stored
together with the exact data it was trained on and the evaluation results that justified
promoting it. This means an engineer can always answer "what model made this call, on what
evidence" with an exact record rather than a best guess, months later — something that
matters for a system whose calls carry real maintenance cost and, over time, audit scrutiny.

Deployment is staged, not an instant swap. A newly validated model is first run alongside the
model currently in use, scoring the same live data, without yet being allowed to drive real
alerts or maintenance recommendations. Only once its behavior on live data is confirmed to
match what validation predicted does it take over (this staged-testing-then-switchover
pattern is often called champion/challenger deployment in industry practice). If a model that
has already taken over is later found to behave worse than expected, the system does not need
an emergency fix under pressure — it simply switches back to the previous version, because
that version was never deleted or overwritten.

Early in the platform's life, when only one or two model versions exist, this discipline
costs almost nothing to maintain. Its value compounds over years of operation: once dozens of
retraining cycles have occurred, the ability to pinpoint exactly which version was live at
any point in the past, and to recover instantly from a bad one, is no longer optional.

**Why this is necessary, and what it prevents:** without kept versions and a staged rollout,
the only way to recover from a bad retrain is an emergency effort performed under pressure
once operators notice something is wrong — precisely the "crisis response" pattern this
platform is explicitly designed to eliminate at the maintenance-action level (Feature 1
justifies planned maintenance over crisis response in exactly these terms). There is no
principled reason to tolerate that failure mode at the model level while eliminating it at
the maintenance level. Keeping every past version and testing new ones before they take over
is standard industrial practice for exactly this reason — it turns "the new model made things
worse" into a one-step, low-drama recovery instead of an incident.

## 14. Generic, Asset-Agnostic Design and Platform Integration

The architecture is asset-agnostic by construction, not by omission. Every component
downstream of Data Preparation operates on **channel roles** — abstract sensor functions
such as *primary vibration channel*, *process temperature channel*, *flow channel*,
*suction/discharge pressure channel*, *rotational speed channel* — rather than pump-specific
field names. This generalizes a pattern already present in this project's own per-metric
threshold configuration (`server/config/thresholds.js`) from "one fixed set of six pump
metrics" to "a configurable channel-role profile per asset class." A motor is described by
a different subset of channel roles (vibration, winding temperature, current draw) than a
pump (flow, suction/discharge pressure, vibration, motor temperature); the pipeline,
feature engineering, anomaly detection, and classification components are unchanged — only
the channel-role profile and the accumulated exemplar store differ per asset class. This is
the same principle behind ISO 13374's reference information model and the Industrie 4.0
Asset Administration Shell concept: a self-describing, asset-type-agnostic data and
processing architecture, rather than one built around a specific machine's field names.

This generality is also what makes the architecture's reuse across the platform concrete
rather than aspirational:

- **Module 4 (Plant-Wide Anomaly Detection)** reuses the anomaly/novelty-detection
  methodology (component 3a) at cross-asset, cross-system scope instead of within a single
  asset's channels — the same "characterize normal, flag deviation, distinguish familiar
  from novel" approach, just with a wider input scope. This is a direct, literal component
  reuse, not merely a shared design philosophy, and it is what the platform document means
  when it describes Module 4 as complementing rather than duplicating Module 1.
- **Module 6 (Unified Plant Decision Support)** consumes Module 1's outputs — fault type,
  confidence, cost impact, prioritization — exactly as it already does for the existing
  Features 1-5, with model version/validation status available as an additional trust
  signal if useful for the Executive Performance Dashboard.
- **Modules 2, 3, and 5** are not direct consumers of the fault classifier, but the
  lifecycle discipline itself (monitoring → verification → gated retraining → validation →
  versioning) is designed to be the template their own future models follow, rather than
  each module inventing its own bespoke practice. This directly serves the stated objective
  that the system be "practical to maintain in an industrial environment" — one governed
  lifecycle pattern to operate and audit across the platform, not five.

---

## 15. Advantages, Disadvantages, Assumptions, Limitations, and Trade-offs

**Advantages**
- Each component is independently testable and independently improvable — a change to the
  anomaly detector cannot silently break the classifier's behavior, and vice versa.
- Genuinely new fault types are a first-class, detectable outcome ("unknown anomaly"), not
  a silent misclassification.
- Growth is safe by construction: the validation gate mechanically enforces "no regression
  on prior classes" rather than relying on best-effort technique alone.
- The same anomaly-detection component is reused by Module 4, and the same lifecycle
  governance is reusable by every other module — lower total platform maintenance burden
  than five independently-designed ML systems.
- Recovery from a bad model update is a configuration change (reverting to a kept version),
  not an emergency response.
- Starting with traditional, interpretable models keeps every early decision explainable to
  plant engineers and managers, while leaving the door open to more data-hungry models later
  without redesigning anything (section 2.5).

**Disadvantages / costs of this approach**
- More moving parts to build, operate, and monitor than a single model — this is a
  deliberate trade against raw simplicity, justified only because the stated requirements
  (open-set novelty detection, safe long-term growth, no forgetting, auditability) cannot be
  met by a single model at all, not because complexity is being added for its own sake.
- Periodic batch retraining means the system's reaction to a genuinely new, fast-emerging
  condition lags by up to one retraining cycle, rather than updating instantly — a
  deliberate safety trade-off (section 9), not an oversight.
- The exemplar store, validation gate, and version history all require someone to operate
  and audit them — this is a standing operational responsibility, not a one-time build cost.

**Assumptions**
- Engineers/technicians are available and willing to verify flagged segments through the
  existing work-order workflow; the entire mechanism by which new knowledge enters the
  system depends on this human step happening reliably.
- At least a few weeks of confirmed-normal operation is obtainable per new asset or asset
  class, to baseline the anomaly detector.
- The data preparation guarantees this project has already established (physics validation,
  raw-signal preservation, sensor-fault-vs-process-anomaly routing) remain in place and are
  extended to any new asset class, not bypassed for convenience.
- A CMMS/work-order system (or equivalent) exists or will exist to close the verification
  loop in a way engineers actually use day to day.

**Limitations**
- No architecture fixes fundamental data scarcity for very rare fault types — this design
  manages that scarcity safely (by gating classifier training on a minimum exemplar count,
  and by not forcing a decision until enough evidence exists) rather than papering over it.
- Novelty detection can flag that something is abnormal and unfamiliar; it cannot, by
  itself, name or root-cause a fault type it has never been shown a confirmed example of —
  that remains a human expert judgment until enough verified examples accumulate to train a
  new class.
- Cross-asset-class generalization of a shared feature representation is a design
  hypothesis, not a guarantee — some asset classes may still need class-specific feature
  tuning within the generic channel-role schema, particularly for asset physics that differ
  substantially from rotating equipment (e.g., static heat exchangers or tanks), which
  should be revisited as the platform is extended beyond pumps and rotating equipment.

---

## 16. Alternative Architectures Considered

The recommended architecture was arrived at by evaluating and rejecting several plausible
alternatives, not by assuming it from the outset. This section summarizes the main ones
considered, so the trade-offs behind the final design are visible rather than implicit.

**Single supervised fault classifier**
- *What it is:* one multi-class model trained on all historical data, with "normal" as one
  of its trained classes alongside each known fault type.
- *Advantages:* the simplest architecture to build, explain, and deploy; a single artifact
  to train, evaluate, and version; effective for well-represented fault classes with enough
  historical examples.
- *Why not selected:* cannot express "I don't recognize this" — every input is forced into
  one of its trained classes, so a genuinely new fault type is guaranteed to be silently
  mislabeled as whichever known class it most resembles. This directly conflicts with the
  requirement to identify abnormal behavior that does not match any previously known fault,
  and its overall trustworthiness is capped by its worst-represented class — a real risk for
  most fault types with only three months of data behind them (section 2.1).

**Pure anomaly detection (no fault classification)**
- *What it is:* a single novelty/anomaly-detection layer that flags any deviation from
  normal operation, without attempting to name what kind of fault it is.
- *Advantages:* needs the least data of any option, working from normal-operation data
  alone; naturally handles novel conditions, since it never assumes a closed set of fault
  types; simple to reason about and validate.
- *Why not selected:* cannot deliver the specific maintenance recommendation, urgency level,
  cost comparison, or priority ranking this module's other features already promise, all of
  which depend on knowing what kind of problem was found, not just that one exists. It also
  discards the value of the fault history already confirmed and still accumulating, treating
  a well-understood recurring fault the same as a first-ever occurrence, and reintroduces the
  alert-fatigue risk Feature 5 is designed to avoid (section 2.2).

**Deep learning as the primary initial solution**
- *What it is:* using large neural-network models (e.g., deep sequence or
  representation-learning architectures) as the main approach for anomaly detection and/or
  fault classification from the outset.
- *Advantages:* strong results on benchmark fault-diagnosis datasets when trained on large
  volumes of labeled data; can learn complex feature representations automatically rather
  than requiring hand-engineered features; a natural longer-term fit for sharing a
  representation across many asset types.
- *Why not selected, for now:* three months of data with only a handful of confirmed
  episodes per fault type is well below the volume deep models need to generalize rather
  than memorize; results would also be harder to validate with the limited held-out data
  available, and harder to explain to the plant engineers and managers whose trust the
  platform depends on early in its life (section 2.4). This is a starting-point decision, not
  a permanent one — section 2.5 explains how the architecture accommodates moving individual
  components to deep learning once enough verified data justifies it.

**Fully online / continuous incremental learning**
- *What it is:* updating the deployed model's parameters immediately, in place, every time a
  new verified example becomes available, rather than retraining periodically in batches.
- *Advantages:* reacts to new information as fast as it becomes available, with no lag
  between verification and the model reflecting it; no separate retraining process to
  schedule or operate.
- *Why not selected:* there is no natural point at which to evaluate a continuously-changing
  model before it starts affecting live alerts, no discrete version to revert to if a bad or
  ambiguous example degrades it, and a single mislabeled engineer verification could silently
  and immediately affect production behavior. Industrial practice (IBM Maximo Predict's
  documented experience) instead treats model updates as planned, evaluated events — this
  project's periodic, gated retraining follows that same reasoning, trading immediacy for the
  ability to verify, and if necessary undo, every change before it reaches production
  (section 9).

---

## 17. Justification Summary Table

| Decision | Alternative rejected | Why this decision satisfies the requirements |
|---|---|---|
| Multi-component pipeline (anomaly detection + classification, separately) | Single end-to-end supervised classifier including a "normal" class | A closed-set classifier cannot express "unknown fault"; it forces novel conditions into the nearest known class instead of flagging them, which directly violates the requirement to identify previously-unseen behavior |
| Anomaly detection combined with fault classification (hybrid) | Anomaly detection alone, with no fault-type classification | Anomaly-only detection cannot deliver the specific maintenance recommendation, urgency, cost comparison, or priority ranking the platform's other features already promise, and treats well-understood recurring faults the same as genuinely novel ones, wasting verified fault history and reintroducing alert fatigue |
| Anomaly detector trained only on normal data, gating the classifier | Anomaly signal derived from low classifier confidence | Closed-set classifier confidence is a documented poor proxy for novelty/out-of-distribution detection; an explicit component trained on the data regime this project actually has in abundance (normal operation) is more reliable and available sooner |
| Traditional/classical ML for each component's initial implementation | Deep learning models as the initial implementation | Deep models need far more data than three months (with only a handful of confirmed episodes per fault type) can provide to generalize rather than memorize, and are harder to validate and explain to non-ML stakeholders whose trust the platform depends on early on; the architecture allows moving individual components to deep learning later (section 2.5) once data justifies it |
| Periodic, gated batch retraining | Continuous/online learning on every new verified label | Online learning has no natural pre-deployment evaluation point, no defined version to revert to, and risks silent degradation from a single ambiguous label; industrial practice (IBM's documented experience) treats retraining as a planned, evaluated event |
| Retraining on the full accumulated set of verified examples, old and new | Training only on data collected since the last retraining run | Rehearsing old exemplars alongside new ones is a standard, verifiable way to avoid losing prior knowledge; it requires no new infrastructure beyond the human-verification exemplar store this design already needs |
| Mandatory all-classes regression check in the validation gate | Validating only the new/updated class before promotion | Only a mechanical, mandatory check against every previously known class actually *guarantees* "no regression on prior knowledge" — technique alone reduces risk but doesn't prove absence of forgetting for a specific candidate |
| Chronological / walk-forward evaluation only | Random or k-fold cross-validation split | This project's own data shows strong lag-1 autocorrelation (~0.9); a random split leaks via near-duplicate neighboring samples and produces fictitious accuracy — a structural property of the data, not a one-off fix |
| Keeping every validated model version, staged testing before switchover, easy reversion | Direct in-place model replacement on retraining | Without kept versions and a staged rollout, recovering from a bad model requires an emergency retrain under pressure — exactly the "crisis response" pattern this platform is designed to eliminate at the maintenance level; it shouldn't be tolerated at the model level either |
| Generic channel-role schema instead of pump-specific fields | Asset-specific pipeline per equipment type | Required by the explicit constraint that the design not depend on one asset type; also the concrete mechanism that lets Module 4 reuse the same anomaly-detection component across assets rather than reimplementing it |
| Cost-based / relative bar for promoting a new model | Fixed absolute accuracy threshold | Matches this project's own existing plan to threshold alerts on expected cost rather than an arbitrary probability cutoff; ties model promotion to demonstrated reduction in expected operational cost, not an abstract metric |

---

## 18. References

Industrial platforms and documented practice:

- Siemens Senseye Predictive Maintenance — anomaly detection, AI/ML pattern matching,
  degradation forecasting, and advisory generation as separate pipeline stages:
  [Senseye Predictive Maintenance | Siemens](https://www.siemens.com/en-us/products/industrial-digitalization-services/senseye-predictive-maintenance/),
  [ARC Advisory Group review](https://www.arcweb.com/industry-best-practices/senseye-predictive-maintenance-ai-driven-visibility-insights)
- IBM Maximo Predict — deployment/monitoring/retraining as decoupled lifecycle phases,
  technician feedback in work orders, documented drift-and-planned-retraining example:
  [Deploying and Monitoring IBM Maximo Predict Models](https://themaximoguys.ai/blog/mas-predict-deployment-monitoring),
  [The Role of AI in Predictive Maintenance | IBM](https://www.ibm.com/think/insights/ai-in-predictive-maintenance)
- C3 AI Reliability — unified domain data model across sensor/document/process sources for
  predictive analytics: [C3 AI Reliability](https://c3.ai/products/c3-ai-reliability/)
- ABB Ability Genix and Schneider Electric EcoStruxure — asset performance management and
  energy/reliability platforms built on a contextualized, cross-asset data model (market
  context): [Green Quadrant: Industrial AI Analytics Software (2025), Verdantix](https://www.verdantix.com/venture/report/green-quadrant--industrial-ai-analytics-software-2025)

Standards:

- ISO 13374 (Parts 1-4) — Condition monitoring and diagnostics of machines: reference
  information/processing model dividing the pipeline into Data Acquisition, Data
  Manipulation, State Detection, Health Assessment, Prognostic Assessment, and Advisory
  Generation: [ISO 13374-4:2015](https://www.iso.org/standard/54933.html)
- ISO 17359 — General guidelines for condition-monitoring and diagnostics program framework.

Academic literature:

- Continual learning / catastrophic forgetting survey — stability-plasticity dilemma;
  replay-based, regularization-based, and architecture-based mitigation taxonomy:
  ["A Continual Learning Survey: Defying Forgetting in Classification Tasks", IEEE
  TPAMI](https://ieeexplore.ieee.org/iel7/34/4359286/09349197.pdf)
- Continual learning applied to non-stationary condition-monitoring data streams:
  [ScienceDirect, "A continual learning approach for failure prediction under non-stationary
  conditions"](https://www.sciencedirect.com/science/article/abs/pii/S0360835225001950)
- Open-set / hybrid anomaly detection — separating novelty detection from closed-set
  classification: [DenseHybrid: Hybrid Anomaly Detection for Dense Open-set Recognition,
  arXiv:2207.02606](https://arxiv.org/abs/2207.02606),
  [Qsco: A Quantum Scoring Module for Open-set Supervised Anomaly Detection,
  arXiv:2405.16368](https://arxiv.org/pdf/2405.16368)
- Hybrid unsupervised-anomaly-detection-plus-supervised-classification frameworks for
  industrial predictive maintenance:
  ["Hybrid Deep Learning for Predictive Maintenance in Industrial Machinery"](https://www.mdpi.com/2075-1702/14/2/191)
- Small-data / few-shot industrial fault diagnosis — why normal-condition modeling scales
  down to far less data than multi-class fault typing, and why deep models struggle with
  scarce, imbalanced industrial fault samples:
  ["A Few-Shot Learning Based Fault Diagnosis Model Using Sensors Data from Industrial
  Machineries"](https://www.mdpi.com/2571-631X/6/4/59)
- MLOps staged-rollout, model-history, and automated-rollback practice: [Introducing MLOps
  Champion/Challenger Models, DataRobot](https://www.datarobot.com/blog/introducing-mlops-champion-challenger-models/),
  [Automated Model Retraining & Deployment, Snowflake](https://www.snowflake.com/en/developers/guides/ml-champion-challenger-model-deployment/)

Existing project documentation this design builds on directly:

- `FAULT_PREDICTION_PLAN.md` — data-leakage rationale (autocorrelation), episode-count
  gating, walk-forward evaluation harness, cost-based alert-threshold plan.
- `docs/plan/2026-07-16-pipeline-review-response.md` — physics-validation and
  sensor-fault-vs-process-anomaly routing principles reused in section 6/14.
- `server/services/driftService.js`, `server/services/forecastService.js` — the existing
  rule-based degradation/drift signal generalized in sections 6 and 11.
- `server/preprocessing/faultClassifier.js` — the existing sensor-fault-vs-genuine-anomaly
  routing principle this design's Data Preparation component extends.
