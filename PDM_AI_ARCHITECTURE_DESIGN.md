# Predictive Maintenance AI System Architecture — Design Proposal

**Scope:** AI system architecture for Module 1 (Predictive Maintenance & Asset Management)
of the AI-Enabled Plant Management Platform described in `AI_Solution_Feature_Design.docx`.

**Prompted by:** reviewer feedback moving the project from feature design to AI system
design. This document does not select a machine learning algorithm. It defines the
components an industrial PdM system needs, how they interact, and why each decision was
made, so that an algorithm choice later (for any single component) is a small, reversible
detail rather than the architecture itself.

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

**Recommendation: a layered, hybrid, multi-component pipeline — not a single model —
modeled on the ISO 13374 condition-monitoring reference architecture (Data Acquisition →
Data Manipulation → State Detection → Health Assessment → Prognostic Assessment → Advisory
Generation), extended with an explicit human-verification loop and an MLOps governance
layer (versioning, staged validation, shadow deployment) drawn from how IBM Maximo Predict,
Siemens Senseye, and C3 AI Reliability operate in long-lived industrial deployments.**

Concretely, the architecture has three groups of components:

1. **Detection core** — data preparation, feature engineering, an anomaly-detection
   component (semi-supervised, trained on normal operation), a known-fault classification
   component (supervised, trained only on verified fault exemplars), and a confidence
   estimation / arbitration layer that reconciles the two into one of three outcomes:
   *normal*, *known fault (type, confidence)*, or *unknown anomaly*.
2. **Human-in-the-loop learning loop** — a verification workbench where engineers confirm,
   reject, or relabel flagged segments, turning "unknown anomaly" into either a new
   confirmed exemplar of an existing fault type or the seed of a new fault class.
3. **Lifecycle governance** — monitoring (drift, performance-vs-baseline), retraining
   orchestration (periodic, class-incremental, replay-based), a validation gate (walk-forward
   evaluation against every previously known class, not just the new one), a model registry
   with versioning, and a champion/challenger deployment process with rollback.

Section 2 argues for this decomposition before anything else, per the reviewer's framing:
the question that matters is *whether* the system should be one model or several, not
*which* model.

---

## 2. Why This Must Be a Multi-Component Architecture, Not a Single Model

A single end-to-end classifier — feed sensor readings in, get a fault label out — is the
default instinct, and it is the wrong one for this project's stated requirements. Four
independent arguments converge on the same conclusion.

**(a) "Is something wrong?" and "what is it?" are different statistical problems with
different data requirements.** Detecting that current behavior deviates from established
normal operation is a one-class / density-estimation problem: it can be learned from
weeks of *normal* data alone, which this project already has in abundance. Naming *which*
known fault type an abnormal segment matches is a multi-class supervised problem: it
needs multiple labeled examples *per class*, and with three months of data and only a
handful of confirmed episodes per fault type, some classes will be well short of that for
a long time. Forcing both problems through one model means the model's weakest data regime
(rare fault classes) determines how well it does at the thing that matters most for safety
and cost avoidance (noticing something is wrong at all). Splitting them lets the
anomaly detector be reliable early, while the classifier's accuracy grows independently
and honestly as labeled examples accumulate.

**(b) A closed-set classifier cannot express "none of the above," and this project
explicitly requires that it can.** A supervised multi-class model, by construction, must
assign every input to one of its trained classes — there is no output slot for "a fault
type I have never seen." Given new operating conditions or degradation modes that were not
in the original training data (an explicit requirement here), a closed-set classifier will
confidently mislabel a novel fault as the nearest known class rather than flag it as novel.
This is the exact failure mode the open-set recognition and hybrid anomaly-detection
literature exists to address — recent work (e.g. DenseHybrid, arXiv:2207.02606; Qsco,
arXiv:2405.16368) treats "detect it's abnormal" and "classify it among known types" as
separable components precisely because a single closed-set model cannot safely do both.
Plain softmax confidence from a closed-set classifier is a documented poor proxy for
out-of-distribution detection — low confidence does not reliably distinguish "novel fault"
from "ordinary noise near a decision boundary." An explicit anomaly/novelty signal, produced
by a component trained only to characterize normal operation, is what makes "previously
unseen fault" a real, actionable output category instead of a silent misclassification.

**(c) Reuse across the platform requires it to be a component, not a monolithic model
internal.** Module 4 (Plant-Wide Anomaly Detection) needs exactly the same
capability — deviation-from-normal detection — just applied across assets and process
signals instead of within one asset's sensors. The platform document already frames Module
4 as complementary to Module 1 ("covering plant-wide and process-level patterns that
asset-specific monitoring is not designed to catch"). If novelty detection is a private
implementation detail buried inside one fault classifier, Module 4 cannot reuse it and the
platform ends up with two independent, divergent anomaly-detection implementations to
maintain. Making anomaly detection an explicit, generic component lets Module 1 and Module
4 share the same underlying methodology at different scopes — one thing to validate, tune,
and monitor instead of two.

**(d) Industrial vendors already build it this way, and this project has already started
to, independently.** Siemens' published Senseye architecture separates anomaly detection,
AI/ML pattern matching, degradation/prognostic forecasting, and advisory generation as
distinct stages rather than a single model call. IBM Maximo Predict documents deployment,
monitoring, and retraining as decoupled lifecycle phases, not one training step, and
explicitly builds technician feedback into the loop as a first-class mechanism, not an
afterthought. This project's own codebase has already converged on the same boundary
without being told to: `driftService.js`/`forecastService.js` provide a
no-training-required, rule-based degradation signal (Feature 1, Early Degradation
Detection) that is completely independent of the not-yet-built supervised fault
classifier reserved for a later phase (Feature 3, Fault Type Classification). The
evaluation harness in `FAULT_PREDICTION_PLAN.md` (Phase 3) already requires any future
classifier to beat that independent rule-based baseline at the same lead time before it may
ship — a promotion-bar pattern that only makes sense if "detect something is wrong" and
"say what it is" are treated as separate, separately-evaluated concerns. This document
formalizes that boundary and builds the rest of the lifecycle around it, rather than
introducing a new one.

**What is rejected, and why:** a single supervised classifier trained on all sensor data
with a "normal" class alongside fault classes. It is simpler to build and explain, but it
inherits the closed-set problem in (b) directly — "normal" would just be another trained
class, and any operating condition unlike anything in the training set (a new fault, a new
regime, a sensor drifting into unfamiliar territory) gets forced into whichever trained
class it resembles most, with no honest signal that it doesn't actually belong to any of
them. That is precisely the behavior this project cannot tolerate for a platform expected
to keep encountering conditions it has never seen.

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
        │ [7] RETRAINING ORCHESTRATION                                  │
        │  periodic / triggered, class-incremental, replay of curated   │
        │  exemplar store (old classes + new)                            │
        └───────────────────────────────────────────────────────────────┘
                                            |
                                            v
        ┌───────────────────────────────────────────────────────────────┐
        │ [8] MODEL VALIDATION GATE                                     │
        │  walk-forward evaluation; regression check across EVERY       │
        │  prior class; promotion bar vs. current champion               │
        └───────────────────────────────────────────────────────────────┘
                                            |
                                            v
        ┌───────────────────────────────────────────────────────────────┐
        │ [9] MODEL VERSIONING & REGISTRY                               │
        │  immutable artifact + training snapshot + eval report, per     │
        │  version                                                        │
        └───────────────────────────────────────────────────────────────┘
                                            |
                                            v
        ┌───────────────────────────────────────────────────────────────┐
        │ [10] DEPLOYMENT: CHAMPION / CHALLENGER, SHADOW, ROLLBACK      │
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
| **Confidence Estimation & Arbitration** | Combine the two upstream signals into one calibrated decision: normal / known fault (with confidence) / unknown anomaly; sets the operating threshold as a cost trade-off, not an arbitrary probability cutoff | Calibration only (e.g. conformal thresholds), not a predictive model of its own | As soon as the two upstream components exist |
| **Human Verification & Labeling Workbench** | Surface flagged segments to engineers/technicians tied to a work order; capture confirm / reject / relabel / new-class decisions | N/A — the mechanism by which humans supply new ground truth | Continuous, throughout the platform's life |
| **Model Monitoring** | Continuously track input-distribution drift, concept drift, and live precision/recall/calibration against the standing rule-based baseline; raise retraining triggers | Statistical monitoring, not predictive | Continuous, always-on |
| **Retraining Orchestration** | Assemble the next training run from the curated exemplar store (old + new), applying replay-based class-incremental learning | Batch, periodic/triggered, never continuous online updates | Triggered by schedule or accumulated verified examples |
| **Model Validation** | Walk-forward (chronological) evaluation of every candidate model against every known class, old and new, plus false-positive rate on confirmed-normal holdout | N/A — evaluation, not learning | Every retraining run, before promotion |
| **Model Versioning & Registry** | Immutable, addressable storage of every validated model version plus its exact training snapshot and evaluation report | N/A | Every promoted version |
| **Deployment / Rollout** | Champion/challenger shadow deployment, staged promotion, rollback to last known-good version | N/A | Every promotion event |

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
   training," is what future retraining draws on — this is what makes safe
   class-incremental learning possible (section 9-10).
5. **Monitoring.** Independently of any retraining, drift and live-performance monitoring
   run continuously and only ever raise a signal — they never change the deployed model
   themselves.
6. **Retraining.** On a schedule or trigger (section 9), a candidate model is trained from
   the full exemplar store using replay-based class-incremental learning.
7. **Validation.** The candidate is evaluated walk-forward against every class the current
   champion knows, plus any new class, and against confirmed-normal holdout for false
   positives. It must clear the promotion bar on all of them, not just the new class.
8. **Versioning and deployment.** A model that passes validation is registered as a new
   immutable version and deployed as a challenger in shadow mode before it ever drives a
   live alert; it is promoted to champion only after a defined burn-in period confirms the
   offline evaluation holds on live traffic.
9. **Continuous improvement.** The loop returns to step 2 with a (possibly) new champion,
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

## 7. Handling Previously Unseen Faults

This is the anomaly/novelty detector's (3a) primary purpose, not a side effect of low
classifier confidence. It is trained in a semi-supervised regime, exclusively on segments
confirmed to be normal operation (via the existing operating-state and quality routing
already in the data preparation stage) — so it never needs examples of a fault to recognize
that current behavior does not resemble normal behavior. This is exactly the property this
project's small, incomplete dataset can support today: normal operation is the large
majority class in any three months of industrial data, and density/deviation modeling
scales down to weeks, not months, of examples per asset — the small-data regime this
project is actually in.

When the detector flags a segment as abnormal, arbitration (component 4) asks a second
question: does this abnormality's feature signature sit close to any known fault class's
learned signature (in which case it is routed to classification), or is it unlike anything
the system has confirmed exemplars for (in which case it is surfaced as an *unknown
anomaly*, not forced into the nearest known label)? This closeness test — comparable to
open-set recognition's approach of thresholding distance-to-known-class exemplars/
prototypes rather than trusting closed-set softmax scores — is what prevents the system from
quietly mislabeling a genuinely new degradation mode as a familiar one, satisfying the
explicit requirement that new fault types, operating conditions, and degradation patterns
never seen in training must be identifiable as such.

An unknown anomaly is not, by itself, a diagnosis — the architecture does not claim to name
a fault it has never been shown an example of. It is a well-calibrated "something here does
not match anything I know, an expert should look" signal, which is exactly the gap between
automated detection and automated diagnosis that human verification (section 8) exists to
close.

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

**Rejected approach: continuous/online learning** (updating model weights on every new
verified example as it arrives). This is unsafe for this deployment for three concrete
reasons: (1) there is no natural point at which to evaluate a continuously-mutating model
before it affects live alerts — validation would have to happen *after* the model has
already changed behavior in production; (2) a single ambiguous or mislabeled engineer
verification could silently degrade the live model with no gate to catch it; (3) rollback
of a model whose weights are constantly being updated is operationally undefined — there is
no discrete "last known-good version" to return to. Industrial practice supports treating
model updates as planned, evaluated events: IBM's own documented experience shows drift
(from a plant process change) being handled through a deliberate, planned retraining and
threshold adjustment, not an automatic in-place update — "model drift is inevitable and
retraining is a planned activity, not a crisis."

**Recommended approach: periodic, gated, class-incremental batch retraining.** Retraining
runs on a schedule (e.g. monthly, or whatever cadence matches how quickly the exemplar
store meaningfully grows) or is triggered early by monitoring (section 11) or by a fault
class crossing its minimum-exemplar threshold. Each run:

- Trains on the **full curated exemplar store** — every previously confirmed example of
  every class, plus new ones — not just data collected since the last run. This is a
  **replay-based** continual-learning strategy: rehearsing old examples alongside new ones
  is one of the standard, well-validated families of technique for mitigating catastrophic
  forgetting (alongside regularization-based and architecture-based methods, per the
  continual-learning literature's taxonomy), and it is the simplest of the three to
  validate and to explain to a non-ML stakeholder — "the model is always trained on
  everything it has ever been shown to be true," which is an easy invariant to audit.
- Where the classifier uses a shared feature representation with lightweight per-class
  heads, a new fault class can also be added **architecturally** — a new output head is
  added while the parameters serving previously-learned classes are frozen or only
  lightly fine-tuned. This structurally bounds forgetting risk for the old classes rather
  than relying purely on rehearsal, and is a reasonable complement to replay rather than
  an alternative to it.
- The candidate is never deployed directly; it goes through the validation gate (section
  12) and staged deployment (section 13) before it can affect a live alert.

This satisfies the explicit requirement that "introducing new knowledge must not reduce
performance on previously learned operating conditions" by making that check a mandatory,
mechanical gate (section 12), rather than a hope.

## 10. Preventing Catastrophic Forgetting

Catastrophic forgetting — a network's performance on previously learned tasks collapsing
once it is sequentially trained on new ones — is the central, well-documented failure mode
of naive sequential learning, and it is the single biggest risk in a system that is expected
to add new fault classes for years. Three complementary safeguards are recommended, matched
to what this deployment can practically operate:

1. **Rehearsal via the curated exemplar store (primary mechanism).** As above — every
   retraining run mixes old and new verified exemplars. This requires nothing more exotic
   than the human verification workbench already producing labeled examples with their
   underlying data retained, which this architecture already requires for other reasons
   (section 8).
2. **Architectural isolation for new classes (secondary, where the classifier's structure
   allows it).** Freezing or lightly constraining parameters tied to existing classes while
   a new class's head is trained bounds the blast radius of adding a class to that class's
   own parameters.
3. **Mandatory all-classes regression testing (the actual enforcement mechanism).**
   Rehearsal and architectural isolation reduce the *likelihood* of forgetting; they do not
   guarantee it didn't happen. The validation gate (section 12) is what actually enforces
   the requirement: every candidate model is evaluated on held-out examples of **every**
   previously known fault class, not only the new one, and any regression below the current
   champion's performance on any prior class blocks promotion outright. This is the
   difference between "we used a technique believed to reduce forgetting" and "we verified,
   for this specific model, that forgetting did not occur" — only the latter is a claim this
   design is willing to make about a system whose mistakes carry real maintenance cost.

This is a deliberately conservative choice: fully generic continual-learning research
(e.g. federated/streaming settings) often optimizes for learning efficiency under storage or
privacy constraints this project does not have. An industrial deployment with a governed
retraining cadence and a maintainable exemplar store can afford simpler, more verifiable
rehearsal-plus-regression-gate discipline over more exotic regularization schemes whose
forgetting-prevention guarantees are harder to demonstrate to a plant engineering
stakeholder.

## 11. Monitoring and Managing Model Drift

Two distinct phenomena are monitored, because they call for different responses:

- **Data drift** — the distribution of incoming sensor readings shifts (a recalibrated
  sensor, a new ambient condition, a process change) even though the fault-relevant
  relationships haven't changed. This project already has a working building block for this:
  `driftService.js`'s reference-vs-recent two-sample statistical test. Generalizing this
  per-channel-role test to run continuously against every deployed model's expected input
  distribution is the natural extension.
- **Concept drift** — the relationship between inputs and true outcomes changes (the same
  vibration signature now means something different because, say, a plant changed its
  cooling-water treatment — IBM's own documented example of exactly this happening to a
  deployed pump bearing model). This is detected by tracking live precision/recall/
  calibration (Brier score) against confirmed outcomes over time, using the same metrics
  this project's existing evaluation harness (`server/preprocessing/evaluation/metrics.js`)
  already computes offline — applied continuously, in production, against the current
  champion.

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
  reported accuracy that does not reflect real predictive skill. That finding is not
  specific to the current phase of this project — it is a structural property of
  time-series sensor data, and this architecture makes chronological, episode-boundary
  splitting a standing rule for every future model, not a one-off fix.
- **Evaluated against every known fault class, old and new — never against the new class
  alone.** This is the mechanical enforcement of the no-regression requirement (sections 9
  and 10): a candidate that improves on a new fault type but degrades recall on a
  previously-learned one fails validation, full stop.
- **Evaluated against confirmed-normal holdout for false-positive rate**, not only true
  positive rate on faults — a model that becomes more sensitive at the cost of flooding
  operators with false alarms fails on the platform's own stated concern about alert fatigue
  undermining adoption (Feature 5).
- **Promotion bar is relative, not absolute.** A candidate must beat the *current champion*
  (and, where relevant, the standing rule-based baseline this project's evaluation harness
  already computes) at the same operating lead-time and cost point — never an arbitrary
  fixed accuracy number, and never a bare probability cutoff. This follows the same
  cost-based-threshold reasoning this project's own plan already applies to alerting
  (Phase 6's plan to alert on expected-cost comparison rather than a 0.5 probability cutoff):
  the model that should ship is the one that demonstrably reduces expected cost/risk
  compared to what's running today, not the one with the highest raw score on an arbitrary
  metric.

## 13. Model Versioning and Rollback

Every model that clears validation is registered, not just deployed. A registry entry is
immutable and bundles three things together as one addressable unit: the trained artifact,
the exact training data snapshot (which exemplars, as of which retraining run), and the
validation report that justified its promotion. This traceability is what lets an
engineer, months later, answer "why did the model call this a bearing fault in March" with
an exact, reproducible answer rather than a best guess.

**Deployment is staged, not a direct swap:**

1. A newly registered version deploys as a **challenger** in **shadow mode** — it scores
   live traffic in parallel with the current champion, but its outputs do not drive alerts,
   maintenance recommendations, or any of the existing cost/priority pipeline.
2. The challenger only becomes champion after a defined burn-in period during which its
   live shadow performance is confirmed to match its offline validation report — protecting
   against the gap between "looked good on held-out historical data" and "actually performs
   well on live conditions."
3. **Rollback is simply re-pointing live serving at the last known-good registered
   version.** Because every version is immutable and self-contained, rollback is a
   configuration change, not an emergency retrain under time pressure.

**Why this is necessary, and what it prevents:** without versioning and staged rollout, the
only way to recover from a bad retrain is an emergency retraining effort performed under
pressure once operators notice something is wrong — precisely the "crisis response" pattern
this platform is explicitly designed to eliminate at the maintenance-action level (Feature 1
justifies planned maintenance over crisis response in exactly these terms). There is no
principled reason to tolerate that failure mode at the model-lifecycle level while
eliminating it at the maintenance level. Champion/challenger with shadow deployment and
registry-backed rollback is the standard industrial MLOps pattern for exactly this reason —
platforms like DataRobot's and Snowflake's champion/challenger tooling, and the broader MLOps
practice of treating models as versioned release artifacts with defined promotion and
automated rollback rules, exist specifically to make "the new model made things worse" a
one-step, low-drama recovery instead of an incident.

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
  each module inventing its own bespoke MLOps practice. This directly serves the stated
  objective that the system be "practical to maintain in an industrial environment" — one
  governed lifecycle pattern to operate and audit across the platform, not five.

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
- Recovery from a bad model update is a configuration change (rollback to a registered
  version), not an emergency response.

**Disadvantages / costs of this approach**
- More moving parts to build, operate, and monitor than a single model — this is a
  deliberate trade against raw simplicity, justified only because the stated requirements
  (open-set novelty detection, safe long-term growth, no forgetting, auditability) cannot be
  met by a single model at all, not because complexity is being added for its own sake.
- Periodic batch retraining means the system's reaction to a genuinely new, fast-emerging
  condition lags by up to one retraining cycle, rather than updating instantly — a
  deliberate safety trade-off (section 9), not an oversight.
- The exemplar store, validation gate, and registry all require someone to operate and
  audit them — this is a standing operational responsibility, not a one-time build cost.

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

## 16. Justification Summary Table

| Decision | Alternative rejected | Why this decision satisfies the requirements |
|---|---|---|
| Multi-component pipeline (anomaly detection + classification, separately) | Single end-to-end supervised classifier including a "normal" class | A closed-set classifier cannot express "unknown fault"; it forces novel conditions into the nearest known class instead of flagging them, which directly violates the requirement to identify previously-unseen behavior |
| Anomaly detector trained only on normal data, gating the classifier | Anomaly signal derived from low classifier confidence | Closed-set softmax confidence is a documented poor proxy for novelty/out-of-distribution detection; an explicit component trained on the data regime this project actually has in abundance (normal operation) is more reliable and available sooner |
| Periodic, gated batch retraining | Continuous/online learning on every new verified label | Online learning has no natural pre-deployment evaluation point, no defined rollback state, and risks silent degradation from a single ambiguous label; industrial practice (IBM's documented experience) treats retraining as a planned, evaluated event |
| Replay-based (rehearsal) class-incremental learning from a curated exemplar store | Training only on data collected since the last retraining run | Rehearsing old exemplars alongside new ones is a standard, verifiable mitigation for catastrophic forgetting; it requires no new infrastructure beyond the human-verification exemplar store this design already needs |
| Mandatory all-classes regression check in the validation gate | Validating only the new/updated class before promotion | Only a mechanical, mandatory check against every previously known class actually *guarantees* "no regression on prior knowledge" — technique alone (rehearsal, regularization) reduces risk but doesn't prove absence of forgetting for a specific candidate |
| Chronological / walk-forward evaluation only | Random or k-fold cross-validation split | This project's own data shows strong lag-1 autocorrelation (~0.9); a random split leaks via near-duplicate neighboring samples and produces fictitious accuracy — a structural property of the data, not a one-off fix |
| Model registry + champion/challenger shadow deployment + rollback | Direct in-place model replacement on retraining | Without a versioned, staged rollout, recovering from a bad model requires an emergency retrain under pressure — exactly the "crisis response" pattern this platform is designed to eliminate at the maintenance level; it shouldn't be tolerated at the model-lifecycle level either |
| Generic channel-role schema instead of pump-specific fields | Asset-specific pipeline per equipment type | Required by the explicit constraint that the design not depend on one asset type; also the concrete mechanism that lets Module 4 reuse the same anomaly-detection component across assets rather than reimplementing it |
| Cost-based / relative promotion bar (beat current champion + rule baseline) | Fixed absolute accuracy threshold | Matches this project's own existing plan to threshold alerts on expected cost rather than an arbitrary probability cutoff; ties model promotion to demonstrated reduction in expected operational cost, not an abstract metric |

---

## 17. References

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
  down to far less data than multi-class fault typing:
  ["A Few-Shot Learning Based Fault Diagnosis Model Using Sensors Data from Industrial
  Machineries"](https://www.mdpi.com/2571-631X/6/4/59)
- MLOps champion/challenger, shadow deployment, model registry, and automated rollback
  practice: [Introducing MLOps Champion/Challenger Models, DataRobot](https://www.datarobot.com/blog/introducing-mlops-champion-challenger-models/),
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
