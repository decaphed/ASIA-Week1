# Predictive Maintenance AI System — Technical Design Specification

**Scope:** AI system design for Module 1 (Predictive Maintenance & Asset Management) of the
AI-Enabled Plant Management Platform. This revision responds to reviewer feedback that the
prior version, while directionally sound, remained a conceptual architecture rather than a
technically justified engineering design: algorithms were unspecified, several components had
unaddressed structural weaknesses (a gatekeeping anomaly detector, an unsupported sample-size
assumption, an unspecified retraining procedure), and the design leaned on a possible future
upgrade (moving to deep learning) as if that upgrade were required for the design to be
considered complete. This revision corrects all of that. It also changes one architectural
decision: known-fault detection is no longer one shared multi-class classifier gated behind
the anomaly detector; it is now an ensemble of independently trained, per-fault-type binary
detectors, scored in parallel. Section 3.4 and Section 13 explain why, in full, since this is
the single most consequential change in this revision.

**How to read this document.** Every major design decision in this document is presented with
the same six-part structure, in this order: (1) why it was selected, (2) alternative
approaches considered and rejected, (3) advantages, (4) disadvantages, (5) how the
disadvantages are mitigated or why they are acceptable, (6) how the decision is validated. This
structure is applied consistently rather than only to a summary table, per the reviewer's
explicit request that this not remain a "high-level list of components or bullet points."

**Traceability to the reviewer's feedback.** The table below maps every specific point raised
to the section that resolves it, so nothing is answered only implicitly.

| Reviewer's point | Where it is resolved |
|---|---|
| "The ML algorithms are not specified" | §8.1 (anomaly detector), §9.1 (fault detectors) — specific algorithms named, with justification and alternatives |
| "The anomaly detector cannot determine whether a fault is known or unknown by itself" | §3.4, §10 — the anomaly detector no longer makes that decision; it produces one input to a separate arbitration policy |
| "The anomaly detector is a risky gatekeeper" | §3.4, §10.3 — the hard gate is removed; every fault-type detector scores every reading regardless of the anomaly detector's output |
| "Retraining may weaken performance on older faults" | §3.5, §13 — structural isolation (independent per-fault-type models) removes cross-class forgetting by construction; residual within-class risk is acknowledged and bounded, not hidden |
| "The proposed 100-200 cases per fault type is unrealistic and unsupported" | §6.2 — replaced with a derived, shown-working sample-size calculation and an explicit tiered data-sufficiency policy |
| "100 windows from one fault event are not equivalent to 100 independent fault events" | §6.1 — the unit of independent evidence is explicitly defined as one fault episode, not a reading or a sliding window |
| "How exactly will retraining occur?" | §12 — a complete, numbered, unambiguous procedure |
| "The design relies too heavily on future upgrades" | §3.6, §18 — the specified components are asserted and argued to be complete and sufficient on their own; deep learning is explicitly non-required |
| "What period before, during, and after the fault will be stored?" | §7 — precursor/active/recovery windows defined with parameterized durations and the reasoning behind them |
| "How will normal operating data be included?" | §6.3, §7.4 — explicit negative-sampling and class-weighting procedure |
| "How will the system confirm that learning a new fault has not reduced its ability to recognize existing faults?" | §13, §14 — structural argument plus the statistical regression test used as defense-in-depth |

---

## 1. Requirements Recap

To keep every downstream decision traceable, the governing requirements are restated here
exactly as given, and referenced by number throughout this document (R1-R7):

- **R1.** The system has access to roughly three months of historical asset-performance data.
- **R2.** The dataset contains examples of some faults, not all possible faults; faults that
  never appeared in the historical data will occur after deployment.
- **R3.** Traditional ML can suit limited data, but the initial training set is fixed, and
  poorly controlled incremental learning may degrade the model over time.
- **R4.** Deep learning typically needs more data than three months is likely to provide for a
  reliable fault classifier.
- **R5.** The system must support learning from newly verified faults without catastrophic
  forgetting, model drift, or a reduction in performance on previously learned operating
  conditions.
- **R6.** The design must remain general — not dependent on one asset type (pump, motor,
  compressor).
- **R7.** Justification, not physics modeling, is the expected form of argument; a detailed
  physics-based model of each fault is out of scope.

---

## 2. Executive Summary of the Recommended Design

The system is a layered pipeline of independently specified, independently validated
components:

1. **Data Preparation** — deterministic, physics-plausibility-checked ingestion (§5.1).
2. **Feature Engineering** — a generic, per-"channel-role" feature set plus derived
   trend/drift signals (§5.2).
3. **Anomaly/Novelty Detector** — one model, trained only on confirmed-normal data, producing
   a continuous deviation score. It does **not** decide known-vs-unknown; that is not its job
   (§8).
4. **Known-Fault Detector Ensemble** — one independently trained binary detector per confirmed
   fault type, scored in parallel with the anomaly detector, never gated behind it (§9, §10).
5. **Arbitration** — a fixed, non-learned decision policy that combines the anomaly score and
   every fault detector's score into one of three outcomes: normal, known fault (type,
   confidence), or unknown anomaly (§10).
6. **Human Verification** — engineers confirm, reject, or relabel flagged segments through the
   existing maintenance work-order flow, producing new ground truth (§11).
7. **Retraining, Validation, Versioning, Monitoring** — a fully specified, per-detector
   lifecycle: retraining is triggered per fault type independently, every candidate is
   statistically compared against the model it would replace before promotion, every version
   is retained for rollback, and drift is monitored continuously without ever directly
   altering a deployed model (§12-16).

The centerpiece of this revision is §3.5/§13: known-fault detection is restructured from one
shared multi-class model into an ensemble of structurally independent per-fault-type models,
specifically because this is the only design considered that removes cross-class catastrophic
forgetting **by construction** rather than relying on testing to catch it after the fact.

---

## 3. Why This Architecture

### 3.1 Why a single supervised classifier (with "normal" as one of its classes) is rejected

**What it is.** One multi-class model, trained on all historical data, where "normal" is just
another output class alongside each confirmed fault type.

**Why it looks attractive.** Simplest to build, train, and explain — one artifact.

**Advantages.** Would perform adequately on whichever fault types already have good historical
coverage; needs only one training pipeline; a well-understood, textbook supervised-learning
setup.

**Disadvantages.**
- *Structural:* a closed-set classifier must assign every input to one of its trained classes.
  There is no output slot for "a fault type I have never seen" (R2). Confidence scores are a
  documented poor proxy for out-of-distribution detection — a model can be highly confident
  and wrong about a genuinely novel condition, because confidence is calibrated relative to the
  classes it was trained on, not relative to the space of everything it was never shown.
- *Data-driven:* with three months of data and, for most fault types, only a handful of
  confirmed occurrences, "normal" and every rare fault type are learned jointly, so the
  classes with the least evidence (the rare faults) are exactly the ones that matter most and
  are learned worst.

**Why this is not acceptable, and why an alternative is required.** R2 explicitly requires
identifying conditions absent from training data. A closed-set classifier cannot do this by
construction, not as a matter of degree — no amount of additional engineering effort on this
approach removes the structural gap. This is why the design is split into a detection layer
that can express "novel" (the anomaly detector) and a naming layer that only ever needs to
discriminate among things it has already confirmed (the fault detectors) — see 3.3.

**How this decision is validated.** Not applicable — this is a rejected alternative; see §19
for its full comparison entry.

### 3.2 Why anomaly detection alone (with no fault-type naming) is rejected

**What it is.** A single novelty-detection layer that flags any deviation from normal
operation without attempting to name the fault type.

**Advantages.** Needs only normal-operation data (which this project already has in
abundance); does not assume a closed set of fault types, so it naturally handles conditions
never seen before; simplest possible design to reason about.

**Disadvantages.**
- Cannot produce a specific maintenance recommendation, urgency level, cost estimate, or
  priority rank — the rest of this module's features (2-5) depend on knowing *what kind* of
  problem was found, not merely that one exists.
- Wastes the confirmed fault history the project already has and will keep accumulating: a
  well-understood, previously confirmed fault would receive the same generic "anomaly" flag as
  a fault type nobody has ever seen, which reintroduces alert fatigue (Feature 5) and never
  converts growing verified knowledge into faster, more specific answers.

**Why this is not acceptable.** The platform's other features require a fault *name*, not just
a deviation flag. Anomaly detection is retained as one necessary half of the design (its data
requirements are not the problem — see 3.3) but cannot be the whole answer.

**How this decision is validated.** Not applicable — rejected alternative; see §19.

### 3.3 Why a hybrid, parallel-scoring architecture is the right balance — and why the anomaly detector must not be a gate

This is where the reviewer's two related concerns are addressed directly: *"the anomaly
detector cannot determine whether a fault is known or unknown by itself"* and *"the anomaly
detector is a risky gatekeeper."* Both are correct criticisms of the prior version of this
design, which had the anomaly detector decide whether the fault-type classifier ran at all
("gates -->" in the previous diagram). That was a design flaw, not a minor simplification, for
two concrete reasons:

1. **It conflates two different jobs.** The anomaly detector's only statistically supportable
   job is "does this look like normal operation or not" — it is trained exclusively on
   confirmed-normal data and has no basis whatsoever for judging whether a deviation matches a
   *known* fault signature, because it was never given any fault examples to learn that from.
   Asking it to gate known-fault detection asks it to make a decision it has no evidence to
   support.
2. **It creates a single point of failure.** If the anomaly detector produces a false negative
   (scores a genuinely abnormal segment as normal — which any real detector will do at some
   rate), the fault-type detectors never even run on that segment under a gated design. A real
   bearing fault could be missed entirely not because the bearing-fault detector failed, but
   because an unrelated component upstream of it failed. That is an unnecessary and avoidable
   risk.

**The fix adopted here:** the anomaly detector and every fault-type detector score **every**
incoming reading, independently and in parallel. Nothing is gated. The anomaly detector's
score is one input to a separate, fixed arbitration policy (§10) — it contributes to flagging
*novelty* when no fault-type detector fires, and to prioritization/confidence context when one
does, but it never prevents a fault-type detector from running or firing.

**Why this is computationally reasonable, not just conceptually nice:** every fault-type
detector recommended in this design (§9.1) is a cheap model — a regularized linear classifier
or a shallow, few-tree ensemble — specifically chosen so that evaluating dozens of them per
reading costs a negligible number of floating-point operations (a small matrix-vector product,
or a handful of shallow tree traversals). There is no meaningful latency or infrastructure cost
to running all detectors on all readings; the "gate" in the prior design was not solving a
performance problem, it was an unnecessary correctness risk.

**Advantages of parallel, non-gated scoring:** no single component can silently suppress
detection of a known fault; the anomaly detector's role is honestly scoped to what it can
actually support (novelty, not classification); adding new information from one detector never
depends on another detector's behavior.

**Disadvantages:** slightly more arbitration logic than a simple pass/fail gate (addressed
directly in §10, which is a short, fixed, auditable decision table, not a learned component);
more than one signal can fire on the same reading, which requires an explicit tie-breaking and
ambiguity-handling policy (§10.2) rather than a trivial gate.

**How this decision is validated:** the arbitration policy itself is deterministic and
auditable by inspection (it is not learned, so there is nothing to "validate" statistically);
each underlying detector is validated independently per §14.

### 3.4 Why known-fault detection is an ensemble of independent per-fault-type models, not one shared multi-class classifier

This is the most consequential decision in this design, directly answering the reviewer's
request to evaluate whether a "genuinely reliable" method exists to prevent retraining from
degrading previously learned faults, and to reconsider the architecture if it does not.

**What the previous design did.** One shared multi-class classifier, trained on all confirmed
fault types jointly. Adding a new fault type meant retraining this one model on the union of
all confirmed examples (old and new), and catastrophic forgetting was addressed by (a)
including old examples in every retrain and (b) testing the retrained model against held-out
examples of every class before promoting it.

**Why that is not a genuinely reliable solution.** Testing for forgetting after the fact is
detection, not prevention. It depends entirely on the statistical power of the regression test
having enough held-out data per class to reliably detect a real regression if one occurred —
and for rare fault types with only a handful of confirmed episodes, that held-out set is often
too small for the test to have any meaningful power (§14.2 shows this quantitatively). A
regression that the test cannot detect is a regression that ships. This is a genuine,
unresolved gap in the previous design, and the reviewer is correct to flag it.

**What this revision does instead.** Each confirmed fault type is modeled by its **own,
independently trained, independently thresholded, independently versioned** binary detector.
There is no shared classifier, no shared decision boundary, and no shared parameters between
fault types anywhere in the design — not in the model weights, and not in the arbitration
thresholds (each fault-type detector's alert threshold is calibrated only against that fault
type's own confirmed-normal/confirmed-fault holdout, never against a global, shared threshold).

**Why this genuinely solves cross-class forgetting, not just tests for it.** Retraining
fault-type X's detector is a self-contained procedure that reads and writes only fault-type X's
model artifact and fault-type X's threshold. Fault-type Y's model artifact is a different file
that is never opened, read, or modified during X's retraining. There is no mechanism by which
retraining X can change Y's behavior, because there is no shared object for that change to flow
through. This is a structural guarantee (true by the way the system is built and deployed), not
a statistical one (true with some probability, checked by a test) — which is the qualitative
difference the reviewer is asking this design to achieve.

**What this does *not* solve, stated honestly.** It does not prevent a fault type's detector
from getting worse at recognizing **its own** older confirmed episodes after being retrained on
an expanded set of its own examples (e.g., if newly added episodes are unrepresentative, or a
different feature subset ends up favored). That is a within-class model-selection risk, and it
exists for any machine learning model of any architecture — it is not specific to this design,
and no architecture eliminates it. This design mitigates (does not eliminate) that residual
risk with a mandatory per-class statistical non-inferiority test before any promotion (§14),
and bounds the risk further with a data-sufficiency floor below which a class's detector cannot
be auto-promoted at all (§6.2, §14.3). Section 13 discusses this distinction — cross-class
forgetting solved by construction, within-class regression bounded by testing — in full.

**Why no alternative architecture does better on this specific question.** A shared multi-class
classifier has this same within-class regression risk *in addition to* the cross-class risk
that structural isolation removes; it is strictly worse on this axis, not merely different.
Continual-learning research techniques that keep a shared model (e.g., parameter-regularization
methods) reduce but do not eliminate cross-class interference either, and are harder to audit
and explain to a plant engineering audience than "these are different files." Given the
project's stated need for an auditable, technically justified guarantee rather than a
best-effort mitigation, structural isolation is the strongest available answer.

**Advantages:** cross-class catastrophic forgetting is structurally impossible; validating an
update to one fault type never requires touching or re-validating any other fault type's
detector or data; a brand-new fault type is added by training one new, small, independent model
with zero risk to anything already deployed; different fault types can use different model
complexity as their own confirmed-data volume independently justifies (§9.1), rather than one
architecture being forced on all classes at once.

**Disadvantages:**
- No statistical sharing across fault types. A shared representation could, in principle, let a
  well-represented fault type's data help a rare fault type generalize (e.g., via multi-task
  learning or a shared embedding). Independent models forgo this.
- More individual artifacts to build, validate, version, and monitor — N fault types means N
  independent detectors plus the anomaly detector, not one model.
- Two or more detectors can fire on the same reading (their decision boundaries can overlap,
  especially between physically similar fault signatures), which requires an explicit
  ambiguity policy rather than being structurally impossible (§10.2).

**Why the disadvantages are acceptable.**
- The statistical-sharing benefit of a joint model is speculative and unlikely to be realized
  reliably with this little data in the first place (a shared embedding needs enough data across
  classes to learn a *good* shared representation; with three months of data and mostly rare
  fault types, there usually isn't enough to make that sharing trustworthy, so the theoretical
  advantage of joint modeling is not a benefit this project can actually count on today).
- The added maintenance burden (N detectors) is real but bounded and linear, and is handled by
  applying the exact same lifecycle procedure (retraining trigger → data selection → validation
  → promotion → versioning, §12/§14/§15) uniformly to every detector — it is one procedure
  applied N times, not N different procedures invented separately.
- The multi-fire case is not a flaw to eliminate but a genuine, useful signal: it means two
  fault types' confirmed signatures are hard to distinguish from each other on the current
  feature set, which is exactly the kind of case that should reach a human reviewer rather than
  being silently resolved by an automatic tie-break (§10.2).

**How this decision is validated:** validated per-detector (§14), not as a joint architecture —
that is precisely the property being claimed.

### 3.5 Why traditional, interpretable models — not deep learning — and exactly which ones

This directly answers "the ML algorithms are not specified." Specific algorithms and their
justification for anomaly detection and known-fault detection are given in full in §8.1 and
§9.1 respectively; this subsection gives the reasoning for the *category* of model chosen
(classical/statistical, not deep learning), which applies to both.

**Why not deep learning, specifically for this deployment (R4):**
- *Data volume.* Deep models typically need labeled examples in the thousands to millions to
  generalize rather than memorize. This project has three months of data and, for most fault
  types, a handful of confirmed episodes. A deep model trained on that little data is far more
  likely to fit the specific quirks of its few examples than a signature that generalizes to
  future occurrences.
- *Auditability.* The audience deciding whether to trust this system is plant engineers and
  managers, not machine learning specialists. A regularized linear model's coefficients, or a
  shallow tree's split points, can be inspected and checked against physical intuition (e.g.,
  "this detector weights rising vibration and falling flow rate positively" is a sentence an
  engineer can evaluate). A deep network's internal representations cannot be checked this way.
- *Validation feasibility.* §14 depends on having enough held-out data per class for a
  statistical test to have power. A model with many more parameters needs proportionally more
  held-out data to produce a validation result that means anything; a simpler model can be
  validated meaningfully on the amount of data this project can actually spare for evaluation
  today.
- *Deployment simplicity.* The recommended models (§8.1, §9.1) run in production as a small
  number of floating-point operations per reading, requiring no specialized inference
  infrastructure (no GPU, no serving framework beyond whatever already runs the existing
  feature-engineering pipeline).

**Advantages of this choice:** every component is explainable, cheap to run, cheap to
retrain, and validated with statistically meaningful tests given the available data.

**Disadvantages:** lower theoretical ceiling on accuracy than a deep model *if* enough data
ever existed to train one reliably; cannot automatically learn feature representations, so
feature engineering (§5.2) is a manually designed, deterministic step rather than learned.

**Why the disadvantages are acceptable, and why this is not a "future upgrade" dependency.**
The theoretical accuracy ceiling of deep learning is irrelevant if the data does not exist to
reach it reliably — a higher ceiling reached unreliably is worse than a lower ceiling reached
reliably, for a system whose mistakes have real maintenance cost. Critically: **this design
does not require ever adopting deep learning to be complete or correct.** Every requirement
(R1-R7) is met using only the components specified in §8.1 and §9.1, using data volumes this
project already has or will accumulate through normal operation. §18 discusses future
enhancement as an optional, non-load-bearing possibility, not a dependency.

**How this decision is validated:** implicitly, by every model in this design successfully
passing the validation procedure in §14 using only the data volumes actually available; if a
specific fault type's data grows large enough that a more complex model (still classical, e.g.
gradient boosting, §9.1) demonstrably and validatedly outperforms the simpler default for that
one class, that upgrade is made for that one class only, using the same promotion procedure as
any other retraining event — an incremental, evidence-gated escalation, not a wholesale
architecture change.

### 3.6 Explicit statement: this design does not depend on a future upgrade

Because the reviewer specifically flagged "the design relies too heavily on future upgrades,"
this is stated plainly and separately: nothing in §1's requirements (R1-R7) requires deep
learning, a larger dataset than what this project will have, or any component not already
specified in this document. The anomaly detector (§8.1) and fault detectors (§9.1) are fully
specified, concrete, classical algorithms that can be implemented and validated using three
months of data and the data volumes this project will accumulate through ordinary operation.
Any future upgrade mentioned in this document (escalating a specific fault type to a shallow
ensemble once its own data justifies it, §9.1; a hypothetical future move to deep learning for
a fault type with very large confirmed volume) is presented as optional and additive, never as
a prerequisite for the system to satisfy R1-R7 as specified today.

---

## 4. System Architecture Diagram

```
                    HISTORICAL DATA (~3 months, incomplete fault coverage)
                                        |
                                        v
        ┌───────────────────────────────────────────────────────────────┐
        │ [1] DATA PREPARATION (§5.1)                                    │
        │  ingestion, physics-plausibility checks, sensor-fault vs.      │
        │  process-anomaly routing, gap-aware imputation, raw signal     │
        │  preserved                                                     │
        └───────────────────────────────────────────────────────────────┘
                                        |
                                        v
        ┌───────────────────────────────────────────────────────────────┐
        │ [2] FEATURE ENGINEERING (§5.2)                                 │
        │  generic per-channel-role features (statistical, trend,        │
        │  drift), per-regime baselining                                 │
        └───────────────────────────────────────────────────────────────┘
                                        |
                ┌───────────────────────┼───────────────────────────┐
                v                       v                           v
    ┌───────────────────┐   ┌───────────────────┐       ┌───────────────────┐
    │ [3] ANOMALY /       │   │ [4a] FAULT          │  ...  │ [4n] FAULT          │
    │     NOVELTY         │   │ DETECTOR: TYPE 1    │       │ DETECTOR: TYPE N    │
    │     DETECTOR (§8)    │   │ (§9) — independent,  │       │ (§9) — independent,  │
    │  scores EVERY        │   │ own model, own       │       │ own model, own       │
    │  reading; does NOT   │   │ threshold, own       │       │ threshold, own       │
    │  gate [4a]-[4n]      │   │ version history       │       │ version history       │
    └───────────────────┘   └───────────────────┘       └───────────────────┘
                │                       │                           │
                └───────────────────────┼───────────────────────────┘
                                        v
        ┌───────────────────────────────────────────────────────────────┐
        │ [5] ARBITRATION (§10) — fixed, non-learned decision table:     │
        │  any fault detector fires  -> KNOWN FAULT (type, confidence)   │
        │  none fire, anomaly fires  -> UNKNOWN ANOMALY                  │
        │  neither fires             -> NORMAL, no alert                 │
        │  multiple fault detectors fire -> flagged as ambiguous (§10.2) │
        └───────────────────────────────────────────────────────────────┘
              |                       |                        |
              v                       v                        v
          no alert          Features 1-5 alert /       routed to review
                             recommendation / cost              |
                             pipeline (existing)                v
        ┌───────────────────────────────────────────────────────────────┐
        │ [6] HUMAN VERIFICATION (§11) — engineer confirms/rejects/      │
        │  relabels via work order; captures precursor/active/recovery   │
        │  window (§7); verified case -> per-type confirmed-episode log   │
        └───────────────────────────────────────────────────────────────┘
                                        |
                                        v
        ┌───────────────────────────────────────────────────────────────┐
        │ [7] MONITORING (§16) — always-on, alert-only, per detector     │
        └───────────────────────────────────────────────────────────────┘
                                        |
                                        v
        ┌───────────────────────────────────────────────────────────────┐
        │ [8] RETRAINING (§12) — per fault-type detector, independently  │
        │  triggered; anomaly detector retrained on its own schedule     │
        └───────────────────────────────────────────────────────────────┘
                                        |
                                        v
        ┌───────────────────────────────────────────────────────────────┐
        │ [9] VALIDATION (§14) — statistical non-inferiority test        │
        │  against the SAME fault type's currently-deployed detector      │
        │  only; other detectors are never touched or re-validated       │
        └───────────────────────────────────────────────────────────────┘
                                        |
                                        v
        ┌───────────────────────────────────────────────────────────────┐
        │ [10] VERSIONING & ROLLBACK (§15) — per detector, independent   │
        └───────────────────────────────────────────────────────────────┘
                                        |
                        (feeds back into [3]/[4a]-[4n] serving)
```

---

## 5. Component-by-Component Specification

Every component below is specified against the same six questions: what it does, its inputs,
its outputs, why it is needed, what it assumes, and how it is validated.

### 5.1 Data Preparation

- **What it does.** Ingests raw sensor streams; checks each reading against physically
  plausible bounds and rate-of-change limits per channel role; distinguishes sensor/wiring
  faults (flatlined, pinned-at-boundary, or implausible instantaneous readings) from genuine
  abnormal process behavior; imputes missing values only across gaps short enough that
  interpolation is physically defensible; preserves the raw reading alongside any smoothed
  copy so no downstream component ever trains on fabricated signal.
- **Inputs.** Raw per-channel-role sensor readings at their native sampling interval.
- **Outputs.** A prepared reading stream, each reading tagged with a validity/quality flag
  (valid / sensor-fault / abnormal-but-genuine / imputed) and carrying both raw and any
  smoothed value.
- **Why it is needed.** Every downstream component (feature engineering, both detector
  families) depends on not being fed sensor artifacts as if they were real process behavior;
  this is the boundary that prevents a wiring fault from being learned as a bearing fault.
- **Assumptions.** Per-channel-role physical bounds and rate-of-change limits can be specified
  (from equipment nameplate data, commissioning tests, or engineering judgment) generically per
  channel role, not per specific asset; at least one redundant or contextual signal (a
  neighboring reading in time, or a correlated channel) exists to distinguish a sensor fault
  from a genuine excursion in the common case.
- **How it is validated.** Deterministic component — validated by unit-level rule testing
  (known sensor-fault signatures, e.g. a flatlined channel, must be classified as sensor-fault;
  known genuine-excursion signatures must not), not by statistical model validation, since it
  contains no trained model.

### 5.2 Feature Engineering

- **What it does.** Converts prepared readings into a generic feature vector per channel role:
  rolling mean, rolling standard deviation, rolling rate-of-change (slope over a fixed recent
  window), and a drift statistic (a two-sample comparison of a short recent window against a
  longer reference window, per channel role), computed relative to the currently identified
  operating regime's baseline.
- **Inputs.** The prepared reading stream from §5.1, plus the currently identified operating
  regime (a discrete label such as "steady-state," "startup," "shutdown," or a data-driven
  cluster identifier if regimes are not explicitly instrumented).
- **Outputs.** A feature vector per reading (or per fixed aggregation interval, matching the
  cadence already used elsewhere in the platform), the same feature schema for every asset of a
  given class, differing only in which channel roles are populated.
- **Why it is needed.** Both detector families operate on this feature vector, not on raw
  readings, so that (a) the same detector architecture and code path serves any asset class
  (R6) and (b) simple models (§3.5) receive derived signal (trend, drift) that gives them
  access to nonlinear-seeming patterns without needing a nonlinear model.
- **Assumptions.** Operating regimes can be identified (either from an existing status signal
  or from a simple clustering of steady-state feature statistics); the chosen rolling-window
  lengths are long enough to be stable but short enough not to blur a fault's onset — this
  window length is itself derived per channel role from that channel's characteristic response
  time (§7.1), not fixed arbitrarily.
- **How it is validated.** Deterministic transforms — validated by confirming feature values
  against hand-computed examples on synthetic and historical data, and by confirming that known
  fault episodes produce the expected qualitative feature signature (e.g., a confirmed bearing
  fault episode's vibration rolling-mean and rate-of-change both increase).

### 5.3 Anomaly / Novelty Detector

Fully specified in §8. Summary: one model per asset class (or per asset, if enough
regime-specific normal data exists), trained only on confirmed-normal feature vectors,
producing a continuous deviation score. Does not gate anything (§3.3, §3.4).

### 5.4 Known-Fault Detector Ensemble

Fully specified in §9. Summary: one independently trained binary detector per confirmed fault
type, each scoring every reading in parallel with the anomaly detector.

### 5.5 Arbitration

Fully specified in §10. A fixed, non-learned decision table; not itself a trained model.

### 5.6 Human Verification Workbench

Fully specified in §11.

### 5.7 Monitoring, Retraining, Validation, Versioning

Fully specified in §12-§16, applied independently per detector.

---

## 6. Training Dataset Strategy

### 6.1 What constitutes one training example: episodes, not windows

**The problem being corrected.** The previous version of this design referred to "100-200
cases" without defining what a "case" is, and implicitly conflated the number of feature rows
(readings, or overlapping sliding windows over readings) generated during a fault with the
number of independent occurrences of that fault. These are not the same thing, and the
reviewer is correct that treating them as equivalent overstates how much evidence exists.

**Definition adopted.** The unit of *independent* evidence is one **fault episode** — a single,
contiguous occurrence of a given fault type, from its detected onset to its detected
resolution (return to normal operation), however many individual readings or feature rows that
episode contains. Readings within one episode are highly autocorrelated (adjacent readings
during the same physical event are not independent observations of "what a bearing fault looks
like" — they are repeated, correlated glimpses of the *same* occurrence). Therefore:

- Multiple readings or overlapping windows drawn from a single episode may still be used as
  **training rows** (more rows from the same episode can still help a model learn the shape of
  that episode's signature, and are not discarded), but they must **never** be counted as
  independent samples for any statistical claim about how much evidence exists for a fault
  type, and they must **never** be split across a train/validation boundary from each other
  (an episode is kept whole on one side of any train/validation split — see §14.1).
- "100 windows from one fault event" is one episode's worth of evidence, not 100 independent
  confirmations, and is treated as such throughout this design.

### 6.2 Minimum data requirements, derived rather than assumed

**The problem being corrected.** "100-200 cases per fault type" was previously stated without
derivation. This section derives a defensible number instead, shows the arithmetic, and is
explicit that even the derived number is a substantial bar many fault types will not meet
within the first three months — which the design must handle as an expected, ongoing state
(§6.2.3), not a temporary inconvenience.

**6.2.1 The statistical target.** The quantity that matters operationally is a fault
detector's true recall (the fraction of real occurrences of that fault it will flag) and false
positive rate (the fraction of normal operation it will incorrectly flag). Both are binomial
proportions. The number of independent episodes needed to estimate a binomial proportion to
within a target margin of error `E`, at confidence level `1-α`, using the standard
normal-approximation sample-size formula, is:

```
n >= z^2 * p * (1 - p) / E^2
```

using the worst case `p = 0.5` (which maximizes the required `n` and is the conservative,
defensible choice when the true recall is unknown in advance).

**6.2.2 Worked numbers, shown explicitly (not asserted):**

| Target confidence | Target margin of error (±) | z | Required independent episodes (n) |
|---|---|---|---|
| 90% | 20 percentage points | 1.645 | ≈ 17 |
| 90% | 15 percentage points | 1.645 | ≈ 30 |
| 90% | 10 percentage points | 1.645 | ≈ 68 |
| 95% | 15 percentage points | 1.96 | ≈ 43 |
| 95% | 10 percentage points | 1.96 | ≈ 97 |

This table is the honest origin of a number resembling the previous "100-200" figure: it is
approximately what a 95%-confidence, ±10-point estimate of recall requires — but stated here as
a derived, adjustable target tied to an explicit confidence level and margin, not an assumed
constant, and expressed in **independent episodes**, never windows.

**6.2.3 The tiered data-sufficiency policy adopted.** Because most fault types will not reach
even the loosest of these bars within three months, each fault type's data state is tracked
explicitly, and the system's behavior is defined for every tier — this is a **permanent,
expected part of the design's steady-state operation**, not a temporary bootstrapping problem:

| Tier | Independent confirmed episodes | Detector status | System behavior for this fault type |
|---|---|---|---|
| **Insufficient** | fewer than 10 | none trained | Occurrences surface only as an "unknown anomaly" via the anomaly detector (§8), routed to human review (§11) exactly as any never-before-seen condition would be |
| **Provisional** | 10-29 | trained via leave-one-episode-out cross-validation (§14.1); recall/false-positive estimates carry wide confidence intervals (per §6.2.2, a 90%/±20pt estimate is the best this tier can support) | Scored, and its output shown to the reviewing engineer as a secondary hint alongside any anomaly flag, but it does **not** independently drive the automated alert/recommendation pipeline (Features 2-5) until promoted to Validated |
| **Validated** | 30 or more | trained and validated with a held-out test set (§14.1), recall/false-positive estimated to at least 90%/±15pt precision, tightening further as more episodes accumulate | Fully live; drives automated alerts and the maintenance-recommendation pipeline |

These thresholds (10/30) are the specific defaults used throughout this document, derived from
§6.2.2's ±15-20 point / 90%-confidence rows as a reasonable minimum operating bar; they are
explicitly a configurable starting point, not a universal constant — a fault type whose missed
detection would be unusually costly may reasonably be held at a stricter bar (e.g., require the
±10-point / 68-episode row) before being allowed to drive automated action, and this is a
tunable parameter of the policy, not a fixed part of the architecture.

### 6.3 How class imbalance is handled

Each fault-type detector is a binary classifier: "does this reading match fault type X" versus
"does it not." In production, the true prevalence is extremely imbalanced (normal operation
vastly outnumbers any fault). Training directly on that true prevalence risks a classifier that
trivially always predicts "not X" and still scores well on raw accuracy — this is exactly the
bias the reviewer's feedback warns about ("this could bias the model towards predicting
faults" — the actual risk runs in the opposite direction if handled naively: an imbalanced
training set biases *toward never firing*, which is equally dangerous for a safety-relevant
detector, and is addressed by the following procedure):

1. **Positive examples:** every confirmed episode of fault type X (its precursor, active, and
   recovery windows, per §7), used in full.
2. **Negative examples:** a stratified sample of confirmed-normal segments (§7.4), drawn across
   the full historical period and across operating regimes (not merely from immediately
   outside a fault episode, to avoid the negative set being dominated by one regime), at a
   constructed ratio to the positive count — by default, a roughly 1:1 to 3:1 (normal:fault)
   ratio during training, chosen to keep the training set balanced enough for the model to
   learn a real discriminative boundary rather than defaulting to the majority class.
3. **Correcting back to true prevalence:** because training uses a constructed, more balanced
   sample, the model's raw output score does not reflect the true production prevalence.
   Class weights (inversely proportional to the constructed training ratio) are applied during
   fitting, and the decision threshold used in production is calibrated separately, directly
   against a held-out confirmed-normal sample at true prevalence, to hit a specific target
   false-positive rate (§10.1) — the constructed training ratio and the production threshold
   are deliberately decoupled so that neither compromises the other.

### 6.4 How representative datasets are collected

Negative (normal) examples are sampled continuously across the full historical record, not
excerpted only near fault events, specifically so the anomaly detector and every fault
detector's negative class see the full range of legitimate normal-operation variation
(different times of day, shifts, seasons, and operating regimes where such metadata exists).
This is revisited at every retraining cycle (§12), so the "normal" reference does not go stale
as more operating history accumulates — see §7.4 for the precise mechanism.

---

## 7. Data Collection: Windowing Definition

This section answers, concretely, "what period before, during, and after the fault will be
stored" and "how will normal operating data be included."

### 7.1 Why windows are parameterized by settling time, not a fixed duration

Because this design must remain asset-general (R6), no window length is specified as a fixed
number of minutes. Instead, each channel role has a **characteristic response time**, `tau_c`
— the time for that channel's autocorrelation (already computed for drift monitoring, §16) to
decay below a defined threshold, or equivalently the time constant of a first-order response
fit to that channel's own historical transients. A temperature channel might have `tau_c` on
the order of minutes; a vibration or pressure channel's `tau_c` is typically much shorter. This
is estimated per channel role during commissioning/baselining and re-estimated periodically, so
the same windowing logic applies whether the asset is a pump, a motor, or a compressor, using
each asset's own measured dynamics rather than a hardcoded duration.

### 7.2 The three windows captured for every confirmed episode

| Window | Definition | Length | Purpose |
|---|---|---|---|
| **Precursor** | Ends at detected fault onset | `3 to 5 x tau_c` of the slowest channel role relevant to this fault type (or the slowest monitored channel, as a generic default) before onset | Gives the anomaly detector and, where data permits, the fault detector, access to the lead-time pattern preceding the fault — the precursor signal is what makes early-warning alerting possible at all |
| **Active** | From detected onset to detected return-to-normal | Variable — whatever the episode actually lasted | The core positive-class signature used for fault-type detector training |
| **Recovery** | Starts at detected return-to-normal | `3 to 5 x tau_c` after return-to-normal | Captures post-fault recovery dynamics and confirms genuine resolution; handled carefully per §7.3 so it does not contaminate the normal-operation baseline |

### 7.3 Why the recovery window is not immediately treated as "normal"

Readings can remain statistically atypical for a period after a process has physically
returned to normal (thermal lag, mechanical settling, control-loop overshoot). Relabeling the
entire recovery window as confirmed-normal immediately would contaminate the anomaly detector's
normal-operation baseline with still-recovering readings, which is precisely the kind of
unexamined assumption the reviewer's feedback is asking this design not to make. The rule
adopted: only the portion of the recovery window **beyond** a further `1 x tau_c` buffer past
return-to-normal is eligible to be folded into the confirmed-normal training set; the initial
buffer segment is retained and tagged distinctly (as "recovery," not "normal" and not "fault")
and is excluded from both the anomaly detector's normal baseline and any fault detector's
positive/negative sets until an engineer confirms it should be reclassified.

### 7.4 How normal operating data remains represented during future retraining

At every scheduled retraining event (§12), the confirmed-normal sampling pool used for (a) the
anomaly detector's training set and (b) every fault detector's negative class is **refreshed**
from the full historical record accumulated to date — not reused unchanged from the original
three-month baseline. This is what prevents the definition of "normal" from silently going
stale as the plant's legitimate operating envelope evolves over the platform's lifetime (a
concern directly related to, but distinct from, concept drift, which is monitored separately in
§16), and is the concrete mechanism by which "normal operating data remains represented" over
years of operation, not just at initial deployment.

### 7.5 How data labeling occurs

Labeling originates from two sources, both producing the same schema (episode boundaries, fault
type or "false alarm," and the three windows above):

1. **Historical labeling (initial three months):** episodes already flagged by existing
   threshold/status logic are reviewed and confirmed by an engineer before being used as
   positive training examples — an unreviewed automatic flag is not, by itself, a confirmed
   episode.
2. **Ongoing labeling (post-deployment):** every unknown-anomaly alert and every detector firing
   is routed through the human verification workbench (§11), whose output is the confirmed
   label used for future retraining.

---

## 8. Anomaly / Novelty Detector — Algorithm, Inference, Training, Validation

### 8.1 Algorithm selection

**Recommended algorithm: robust Mahalanobis-distance scoring per operating regime**, using a
Minimum Covariance Determinant (MCD) estimator to compute a robust mean and covariance of the
confirmed-normal feature vectors within each identified operating regime, then scoring each new
reading by its (robust) Mahalanobis distance from that regime's center.

**Why this is appropriate for industrial telemetry, specifically:**
- The feature vector (§5.2) is a moderate-dimension, continuous, roughly-scaled set of
  per-channel-role statistics — exactly the setting Mahalanobis-distance scoring is designed
  for, and it requires no iterative optimization or hyperparameter search beyond regime
  identification (already needed elsewhere in this design).
- It decomposes: the contribution of each channel role to the total distance can be reported
  individually, so an alert can state "vibration is 4.1 robust standard deviations above this
  regime's baseline" rather than an opaque score — directly serving the same
  explainability requirement that governs Feature 4 (Cost Impact Assessment)'s traceability
  requirement.
- The robust (MCD) estimator, rather than a plain sample mean/covariance, is specifically
  chosen because a small fraction of the "normal" training data may itself include
  not-yet-recognized minor anomalies or mislabeled segments; a robust estimator down-weights
  such contamination automatically rather than letting a handful of bad rows distort the entire
  baseline.
- It needs only weeks of confirmed-normal data per regime to fit reliably (a mean and
  covariance matrix over a modest number of features, not a large parameter set), which matches
  the actual data volume available.

**Alternatives considered:**
- *Isolation Forest* — a tree-based partitioning method that does not assume an elliptical
  (Gaussian-like) normal-operation distribution, and can capture more complex, nonlinear normal
  regions. Rejected as the default because (a) its anomaly score does not decompose per channel
  role, which weakens explainability, and (b) it has more hyperparameters (number of trees,
  subsample size) that themselves need a validation set to tune reliably — a harder validation
  problem than the two-moment estimate Mahalanobis scoring requires. It remains a reasonable
  escalation path if, once enough regime-labeled history accumulates, normal operation is
  confirmed to be meaningfully non-elliptical within a regime.
- *One-Class SVM* — a kernel-based boundary around the normal-operation data. Rejected because
  its kernel bandwidth and margin hyperparameters are highly sensitive and themselves require
  a validation procedure to select reliably (a circularity problem when the very thing being
  validated is "how much data do we trust"), and because, like Isolation Forest, it does not
  natively decompose its output per channel role.
- *Autoencoder reconstruction error* — rejected under §3.5's deep-learning argument (data
  volume, auditability); an autoencoder's reconstruction-error signal is also not naturally
  attributable per channel role without additional analysis.

**Disadvantages of the recommended choice:**
- Assumes each regime's normal-operation distribution is reasonably elliptical (unimodal, with
  roughly linear correlation structure among channels). If a regime's true normal behavior is
  multimodal, Mahalanobis scoring can under- or over-flag depending on where a reading falls
  relative to the fitted ellipse.
- Regime identification itself must be reasonably accurate; a misidentified regime feeds the
  wrong baseline into the distance calculation.

**Mitigation:** the elliptical assumption is checked explicitly during validation (§8.4) by
comparing the empirical false-positive rate against the rate the fitted distribution predicts;
a persistent, systematic mismatch is the trigger to escalate that regime to Isolation Forest
(the documented alternative) rather than silently tolerating a poor fit. Regime misidentification
risk is bounded by keeping regime identification itself simple and inspectable (a small number
of discrete, engineer-defined regimes, or a low-dimensional clustering that can be visually
checked), not a black-box process.

### 8.2 Inference in production

For each new prepared, feature-engineered reading: identify the current operating regime;
compute the robust Mahalanobis distance of the reading's feature vector from that regime's
fitted center; this distance is the anomaly score, compared against a threshold calibrated to a
target false-positive rate (§10.1) on confirmed-normal holdout data. This computation is a
single matrix-vector operation per reading — negligible latency, run on every reading, always.

### 8.3 Training

Trained per operating regime, using confirmed-normal feature vectors sampled per §6.4/§7.4.
Retrained on a fixed schedule (default: quarterly) or earlier if drift monitoring (§16) flags
the reference distribution as stale.

### 8.4 Validation before promotion

A candidate anomaly detector is compared against the currently deployed one using the same
paired methodology as fault detectors (§14): both score the same held-out confirmed-normal set
and the same set of confirmed historical episodes (used here only to check that known fault
episodes still produce an elevated score, not to train on). Promotion requires the candidate's
false-positive rate on the confirmed-normal holdout not to increase (tested via McNemar's test,
§14.2, on the same paired held-out readings) and requires that no confirmed fault episode in
the intervening period would have failed to cross the anomaly threshold at the time it
occurred, which is checked explicitly against the human-verification log (§11) before any
promotion.

---

## 9. Known-Fault Detector Ensemble — Algorithm, Inference, Training, Validation

### 9.1 Algorithm selection

**Recommended default algorithm: L2-regularized (ridge) logistic regression**, trained
independently per fault type as a one-vs-rest binary classifier over the same feature vector
used everywhere else in the design (§5.2).

**Why this is appropriate for industrial telemetry, specifically:**
- With the sample sizes realistically available per fault type (§6.2 — often in the tens of
  episodes, not thousands), a regularized linear model is far less prone to overfitting than
  any higher-capacity model, and L2 regularization specifically shrinks coefficients smoothly
  rather than performing hard feature selection, which is more stable with small, noisy samples.
- Fully interpretable: each fitted coefficient states, directly, how much a unit change in one
  channel role's feature (e.g., vibration rate-of-change) shifts the log-odds of this specific
  fault type — an engineer can check this against physical intuition for that fault type.
- Cheap to fit (a small convex optimization problem) and cheap to evaluate in production (a dot
  product and a sigmoid), consistent with §3.3's requirement that running every detector on
  every reading be computationally trivial.
- Class weighting (§6.3) is a standard, well-understood adjustment for this exact algorithm,
  with no additional architectural complexity.

**Escalation path (per fault type, independently, evidence-gated):** once a specific fault
type reaches Validated tier (§6.2.3) **and** its logistic-regression detector's validated
recall is found to plateau below an acceptable level while its confirmed episodes show evidence
of a genuinely nonlinear signature (e.g., a fault only detectable from the *combination* of two
channels crossing thresholds together, not from either alone in a linear sense), that
**specific** fault type's detector may be escalated to a **shallow gradient-boosted ensemble**
(explicitly bounded: maximum tree depth 2-3, no more than ~50 trees), still trained and
validated independently, still not shared with any other fault type. This escalation is decided
and validated per class using that class's own data, exactly like any other retraining event
(§12) — it is not a wholesale architecture change and does not require or assume any other
fault type follows the same path.

**Alternatives considered:**
- *k-nearest-neighbor / prototype-distance classifier* — the simplest possible option: a new
  reading is compared directly against stored confirmed episodes, with no fitted decision
  boundary at all. Advantage: trivially updatable (add a new confirmed episode as a new
  prototype; no retraining "fit" step at all), maximally transparent ("this looks like these
  three confirmed episodes"). Rejected as the *default* because it does not extrapolate — a
  fault type represented by only a few, possibly non-representative confirmed episodes gives a
  brittle decision surface, and query cost grows with the number of stored examples. It is
  retained as the recommended fallback specifically for fault types below even the
  Provisional-tier floor (§6.2.3) where fitting a regularized logistic model is not yet
  advisable, since it requires no real "fitting" step and degrades gracefully with almost no
  data.
- *Deep sequence/embedding models* — rejected per §3.5/§3.6, and explicitly not required.

**Disadvantages of the recommended default (logistic regression):**
- Limited to a roughly linear (in the engineered features) decision boundary; may under-fit a
  genuinely nonlinear fault signature.
- Requires the feature engineering step (§5.2) to have already exposed the relevant nonlinear
  structure (e.g., via rate-of-change and drift features) since the classifier itself cannot
  learn new feature combinations.

**Why the disadvantages are acceptable, and how they are mitigated.** The escalation path above
exists specifically to address the case where linearity is genuinely insufficient, and is
gated on validated evidence rather than assumed in advance — the default is deliberately the
simplest model that is likely to work given the data, escalating only where data and evidence
justify it, consistent with §3.5's validation-feasibility argument.

### 9.2 Inference in production

Every fault-type detector at Provisional tier or above evaluates every incoming feature vector,
in parallel with every other fault-type detector and the anomaly detector (§3.3, §3.4) —
there is no gating. Each detector's raw score is compared against its own independently
calibrated threshold (§10.1). The set of detectors whose score exceeds their own threshold is
passed to arbitration (§10).

### 9.3 Training

Independently, per fault type, using: (a) all confirmed episodes for that fault type as
positive examples (precursor + active + recovery windows, per §7.2), (b) a stratified,
ratio-controlled sample of confirmed-normal segments as negative examples (§6.3, §7.4), with
class weighting applied to correct for the constructed training ratio. Triggered per the
procedure in §12.

### 9.4 Validation before promotion

Fully specified in §14, applied independently per fault type.

---

## 10. Arbitration and Decision Policy

This is the answer to "describe how the system distinguishes normal operation, known faults,
and unknown faults" and "explain why the anomaly detector should not act as the sole
gatekeeper" — arbitration, not the anomaly detector, makes this distinction, using every
detector's output as an input.

### 10.1 Threshold calibration

Every detector (the anomaly detector and each fault-type detector) has its own threshold,
calibrated independently against that detector's own confirmed-normal holdout data to hit a
target false-positive rate — this target is a cost/urgency trade-off (matching this module's
existing cost-based alerting philosophy), not an arbitrary statistical cutoff, and different
fault types may reasonably be calibrated to different false-positive tolerances depending on
the cost of a missed detection versus a false alarm for that specific fault type.

### 10.2 The decision table

Let `F` be the set of fault types whose detector score exceeds its own threshold on the current
reading, and let `A` be true if the anomaly detector's score exceeds its threshold.

| Condition | Outcome |
|---|---|
| `F` is empty, `A` is false | **Normal** — no alert |
| `F` is empty, `A` is true | **Unknown anomaly** — routed to human review (§11); no known fault type is named |
| `F` has exactly one member, at Validated tier | **Known fault**: that type, with a calibrated confidence — feeds the existing Features 1-5 pipeline |
| `F` has exactly one member, at Provisional tier only | Treated as **unknown anomaly** for the automated pipeline, but the Provisional detector's firing is shown to the reviewing engineer as a secondary hint |
| `F` has more than one member | **Ambiguous** — routed to human review regardless of confidence gap between the firing detectors; the reviewer sees all firing detectors and their scores |

**Why the ambiguous case is always routed to a human, never auto-resolved by picking the
highest-confidence detector:** two or more independently trained detectors firing on the same
reading is evidence that their confirmed signatures are not well separated on the current
feature set — silently picking one would hide that fact rather than surface it, and misdiagnosis
between two similar fault types has real cost (wrong parts ordered, wrong technician
dispatched). This is a deliberate design choice to prioritize honest uncertainty over false
confidence, directly serving the alert-fatigue and trust concerns already established elsewhere
in this module (Feature 5).

### 10.3 Why this removes the gatekeeper risk

Because every fault-type detector is evaluated regardless of what the anomaly detector reports,
a false negative in the anomaly detector cannot suppress a known-fault detection — the "Known
fault" row in the table above does not require `A` to be true at all. The anomaly detector's
only role is supplying the "Unknown anomaly" outcome when nothing else fires, and providing
corroborating context, not gating.

---

## 11. Human Verification Workflow

Every "Unknown anomaly" and "Ambiguous" outcome (§10.2) is routed to a verification workbench
tied to the plant's existing maintenance work-order flow, so an engineer resolves it as part of
work already being done (inspecting, repairing, closing out the event), not as a separate
labeling task.

**What the engineer sees:** the flagged reading and its precursor/active/recovery windows
(§7.2); the anomaly score; every fault-type detector's score, whether or not it exceeded its
threshold (so an ambiguous or near-miss case shows its full context, not just the binary
outcome).

**Possible verdicts:**
- **Confirmed known fault** (a specific type) — the episode is added to that fault type's
  confirmed-episode log, used at the next retraining cycle for that type only (§12).
- **Confirmed new fault type** — seeds a brand-new fault type at Insufficient tier (§6.2.3),
  with this episode as its first confirmed example; no existing detector is affected in any
  way, since a new fault type is, by construction (§3.4), a new independent model that does not
  yet exist.
- **False alarm** — the episode is added to the confirmed-normal pool (or, for a fault-type
  detector false alarm specifically, to that detector's negative training set as a documented
  hard case), directly improving future precision for whichever detector raised the alert.

Every verdict is stored with the full underlying window data, not just a label, so the
confirmed-episode log used for retraining always contains complete evidence.

---

## 12. Retraining Workflow — Complete Procedure

This is the literal, numbered answer to "how exactly will retraining occur," applied
independently to each fault-type detector (and, with the adaptations noted, to the anomaly
detector, §8.3-8.4).

1. **Trigger.** Either (a) a defined number of new confirmed episodes (default: 3) has
   accumulated for a given fault type since its detector was last trained, (b) a scheduled
   periodic review (default: quarterly) checks every fault type's accumulated count against
   its tier thresholds (§6.2.3), or (c) a monitoring alert (§16) flags a specific detector's
   live performance for review.
2. **Data selection.** Gather all confirmed episodes to date for this fault type (positive
   class). Split chronologically, never randomly (adjacent-in-time readings are correlated, so
   a random split leaks information from validation into training): for Validated-tier
   retraining, hold out the most recent episodes (a fixed minimum count, default 6, or the most
   recent defined time period, whichever yields more held-out episodes) as the validation set,
   train on the remainder. For Provisional-tier fault types (too few episodes to spare a fixed
   holdout), use leave-one-episode-out cross-validation instead: train on all episodes but one,
   test on the held-out episode, rotate through every episode once, respecting chronological
   ordering within each fold (never testing on an episode using a model trained partly on
   episodes that occurred later in time).
3. **Negative sampling.** Draw the stratified, ratio-controlled confirmed-normal sample per
   §6.3/§7.4, refreshed from the full historical record to date (not reused unchanged from a
   prior cycle).
4. **Feature computation.** Identical production feature-engineering pipeline (§5.2) — no
   separate "training-only" logic.
5. **Model fit.** Fit the candidate detector (logistic regression by default, or the escalated
   shallow ensemble where already justified per §9.1) on the assembled training set, with class
   weighting applied.
6. **Metric computation.** Compute, on the held-out set (fixed holdout or leave-one-out
   aggregate, per step 2): recall (fraction of held-out positive episodes correctly flagged)
   and false-positive rate (on the held-out confirmed-normal sample), each reported with a
   confidence interval sized per §6.2.2 given the actual number of held-out episodes.
7. **Comparison against the currently deployed detector for this same fault type.** Score the
   *same* held-out episodes and *same* held-out normal sample with both the candidate and the
   model currently in production for this fault type. Apply the statistical test in §14.2.
8. **Promotion decision.** Per the acceptance criteria in §14.3.
9. **Versioning and deployment.** If promoted, the new detector is recorded as a new version for
   this fault type (§15) and begins scoring live traffic; the previous version remains
   retrievable. If not promoted, the currently deployed detector for this fault type continues
   unchanged, and the candidate's results (including *why* it failed promotion) are logged for
   engineering review.

**Explicit note on why this never risks other fault types.** Every step above reads and writes
only the data, model artifact, and threshold belonging to the one fault type being retrained.
No other fault type's detector, threshold, or version history is read, written, or evaluated
during this procedure — this is the mechanical expression of the structural-isolation argument
in §3.4/§13.

---

## 13. Preventing Catastrophic Forgetting

This section states, without hedging, exactly what is and is not solved, per the reviewer's
explicit instruction to evaluate reliability honestly rather than assume it.

**Cross-class forgetting — solved by construction.** Because each fault type's detector,
threshold, and version history are structurally independent artifacts (§3.4, §12), retraining
or promoting fault type X's detector cannot alter fault type Y's detector's parameters, because
there is no code path, shared file, or shared training run through which such a change could
propagate. This is verifiable by inspection of the deployment/versioning system (each
detector's artifact is a distinct, independently versioned object, §15) — it does not depend on
a statistical test having enough power to catch a problem; there structurally is no problem of
this kind to catch.

**Within-class regression — mitigated, not eliminated, and this is stated plainly.** Retraining
fault type X's detector on an expanded set of X's own confirmed episodes can still, in
principle, produce a detector that performs worse on X's own older confirmed episodes than the
one it would replace (e.g., if new episodes are less representative, or the fit favors a
different feature subset). This is a normal model-selection risk inherent to retraining *any*
model on *any* new data, regardless of architecture — it is not introduced by this design and
is not eliminated by any architecture, including a shared multi-class classifier (which carries
this same within-class risk in addition to the cross-class risk that structural isolation
removes). This design's mitigation is the mandatory non-inferiority test in §14 before any
promotion, and the explicit acknowledgment that this test's power is bounded by how many
held-out episodes exist (§6.2, §14.2) — below the Provisional-tier floor, a detector is
withheld from autonomous promotion regardless of how good its point estimate looks (§14.3),
specifically because the test cannot be trusted at that sample size.

**Why no alternative architecture is more appropriate, given this residual risk.** The residual
within-class risk is common to every model architecture; it is not a reason to prefer a shared
classifier, since a shared classifier has this same risk plus the cross-class risk this design
removes. No architecture considered (§19) eliminates within-class regression risk entirely — it
is a fundamental property of learning from finite, evolving data, mitigated by validation
discipline (§14), not removed by architectural choice. Given that, the isolated-ensemble
architecture strictly dominates the alternatives on the forgetting axis: equal residual risk
within a class, and zero risk across classes, versus the shared-classifier alternative's equal
residual risk within a class *plus* nonzero risk across classes.

---

## 14. Model Validation and Promotion Criteria

### 14.1 Validation datasets

Per fault type: a chronologically held-out set of that type's own confirmed episodes (fixed
holdout once Validated tier is reached; leave-one-episode-out while at Provisional tier, §12
step 2), plus a shared, stratified confirmed-normal holdout refreshed at each cycle (§7.4).
Episodes are never split across the train/validation boundary (§6.1) and validation data is
always chronologically later than training data, never randomly interleaved with it, for the
same autocorrelation reason given throughout this design.

### 14.2 Regression test

The candidate and the currently-deployed detector for the same fault type are scored on the
identical held-out episodes and the identical held-out normal sample (a paired comparison).
Because samples are frequently small, an **exact McNemar's test** is used rather than a
two-proportion z-test (which requires much larger samples to have any power): McNemar's test
examines only the readings where the two models disagree, and tests whether disagreements favor
the candidate or the currently-deployed model asymmetrically. A pre-registered significance
level of **α = 0.10** is used (deliberately looser than the conventional 0.05), because a false
"no regression detected" finding here is more costly than a false "regression detected" finding
— rejecting a good candidate only means staying on the current, already-acceptable detector one
more cycle, which is always a safe fallback, whereas promoting a truly regressed detector is
not.

**Explicit limitation, stated rather than glossed over:** with very few discordant pairs (which
is likely for fault types with few held-out episodes), even McNemar's test may lack the power to
detect a real regression. This is exactly why the tiered data-sufficiency policy (§6.2.3, §14.3)
exists as a second, independent safeguard — the statistical test is not relied upon in isolation
at small sample sizes.

### 14.3 Acceptance thresholds and deployment criteria

A candidate detector is promoted only if **all** of the following hold:

1. The fault type has reached at least Provisional tier (≥10 independent confirmed episodes,
   §6.2.3); below this, no candidate is auto-promoted regardless of test results.
2. McNemar's test (§14.2) does not find a statistically significant regression at α = 0.10.
3. The false-positive rate on the shared confirmed-normal holdout does not increase beyond a
   pre-agreed tolerance (default: no statistically significant increase, tested the same way).
4. For fault types at Provisional tier specifically, promotion to *driving the automated
   pipeline* (as opposed to being retrained and re-evaluated while remaining Provisional) also
   requires reaching Validated tier (≥30 episodes) — a Provisional detector cannot become
   Validated by passing a regression test alone; it must also cross the data-sufficiency floor.
5. For fault types explicitly designated high-criticality (a configurable, not architectural,
   designation — e.g., a fault type whose missed detection carries unusually high safety or
   cost consequences), promotion additionally requires manual engineering sign-off in addition
   to the automated criteria above, specifically because the automated test's power is bounded
   and a high-consequence fault type warrants a human check beyond what statistics alone can
   guarantee at small sample sizes.

### 14.4 Deployment criteria (restated for clarity)

Deployment is the direct consequence of promotion: exactly one detector artifact and threshold
is live per fault type at any time (plus one anomaly detector per regime); a promoted candidate
replaces it; nothing else changes.

---

## 15. Model Versioning and Rollback Strategy

Every detector (the anomaly detector, per regime, and every fault-type detector, per type) is
versioned independently: each promoted version is retained, tagged with the exact data it was
trained and validated on and the validation results that justified promoting it. Rollback is
per-detector: if a specific fault type's live detector is later found (via monitoring, §16, or
a subsequent validation cycle) to perform worse than expected, only that detector is reverted
to its previous version — no other detector is affected, touched, or needs re-validation, again
a direct consequence of structural isolation (§3.4, §13).

---

## 16. Monitoring for Drift

Two distinct phenomena are monitored, per detector:

- **Data drift** — the feature distribution a detector sees in production diverges from what
  it was trained on (e.g., a recalibrated sensor, a process change), tracked via a
  reference-vs-recent statistical comparison per channel role, independent per regime/fault
  type.
- **Concept drift** — the relationship between features and true outcomes changes for a
  specific fault type (the same signature now means something different), tracked by
  comparing each detector's live precision/recall against confirmed human-verification outcomes
  over time.

Monitoring only ever raises a flag that a specific detector may need retraining (§12) — it never
modifies a deployed detector directly, for the same reason continuous online learning is
rejected (§19): an automatic response with no validation step in between reintroduces exactly
the unverified-change risk this design is built to avoid.

---

## 17. Asset-Generality

Every component above operates on **channel roles** (generic sensor functions: vibration,
process temperature, flow, pressure, rotational speed) rather than asset-specific field names, so
the same pipeline, detector architecture, and windowing logic (§7.1, parameterized by each
channel's own measured response time rather than a fixed duration) applies to a pump, a motor,
or a compressor without modification — only the populated channel-role set and the accumulated
per-fault-type confirmed-episode logs differ per asset class.

---

## 18. Advantages, Disadvantages, Assumptions, and Limitations (Consolidated)

This section consolidates the per-decision disadvantage/mitigation analysis already given
throughout (§3-§14) for at-a-glance review; each item below cross-references its full
discussion rather than repeating it.

**Advantages**
- Cross-class catastrophic forgetting is structurally impossible (§3.4, §13), not merely
  tested for.
- No component can silently suppress another's detection (§3.3, §10.3) — the gatekeeper risk
  is removed.
- Every algorithm is named, justified for this data regime, and cheap enough to run on every
  reading without a gating shortcut (§8.1, §9.1).
- The design is complete and validated using only currently available data volumes; no future
  upgrade is required for correctness (§3.6).
- Data-sufficiency requirements are derived, shown, and tiered (§6.2), not assumed.

**Disadvantages, and why each is acceptable (full discussion cross-referenced)**
- No statistical sharing across fault types (§3.4) — acceptable because the sharing benefit is
  speculative at this data volume in the first place.
- N independent detectors to maintain rather than one model (§3.4) — bounded by applying one
  uniform lifecycle procedure to all of them (§12, §14, §15), not N separate procedures.
- Multi-fire ambiguity requires explicit handling (§10.2) — treated as a valuable signal routed
  to a human, not a flaw to hide.
- Within-class regression after retraining is mitigated, not eliminated (§13) — a limitation
  common to any architecture, bounded by mandatory statistical testing and a data-sufficiency
  floor below which auto-promotion is disallowed.
- Many fault types will remain at Insufficient or Provisional tier for a long time (§6.2.3) —
  treated as a normal, permanent, expected steady state, not a temporary gap papered over with
  an unrealistic sample-size assumption.

**Assumptions**
- Engineers are available and willing to verify flagged segments through the existing
  work-order workflow (§11); the entire mechanism by which new knowledge enters the system
  depends on this.
- Each channel role's characteristic response time (§7.1) can be estimated from historical or
  commissioning data.
- A CMMS/work-order system (or equivalent) exists to close the verification loop.

**Limitations**
- No architecture removes the fundamental scarcity of rare-fault data; this design manages it
  explicitly (tiered status, leave-one-out validation, provisional-only advisory output) rather
  than concealing it.
- Regime identification (§5.2, §8.1) is assumed reasonably accurate; a systematically
  misidentified regime degrades the anomaly detector's baseline, mitigated by the escalation
  and audit path in §8.1/§8.4.
- Cross-asset-class generalization of the channel-role schema (§17) is a design hypothesis for
  asset types physically very different from rotating equipment (e.g., static heat exchangers),
  which should be revisited empirically as the platform extends beyond pumps and rotating
  machinery.

---

## 19. Alternative Architectures Considered

**Single shared multi-class classifier, gated behind the anomaly detector** *(the previous
version of this design)*
- *What it is:* one multi-class model over all confirmed fault types, only evaluated when the
  anomaly detector flags a segment as abnormal.
- *Advantages:* one model to maintain instead of N; potential (unrealized at this data volume)
  statistical sharing across fault types.
- *Why rejected:* the anomaly detector gating known-fault detection creates a single point of
  failure (§3.3); a shared classifier's cross-class forgetting risk is only tested for, never
  structurally removed (§3.4, §13) — exactly the two flaws this revision was written to correct.

**Single supervised classifier including "normal" as a class** — rejected; §3.1.

**Pure anomaly detection, no fault-type naming** — rejected; §3.2.

**Deep learning as the primary initial approach** — rejected as the *starting point*, not
permanently; §3.5, §3.6. Not required for this design to be complete.

**Fully online / continuous incremental learning** — rejected: no natural point to validate a
continuously-changing model before it affects live alerts, no discrete version to roll back to,
and a single mislabeled verification could silently and immediately affect production. The
periodic, validated retraining procedure in §12 trades immediacy for the ability to verify, and
if necessary reject, every change before it reaches production.

---

## 20. Justification Summary Table

| Decision | Alternative rejected | Why this decision satisfies the requirements |
|---|---|---|
| Independent per-fault-type detector ensemble, scored in parallel | Single shared multi-class classifier, gated by the anomaly detector | Removes cross-class forgetting by construction (§3.4, §13) and removes the single-point-of-failure gate (§3.3, §10.3) — the two structural flaws the reviewer identified |
| Anomaly detector as one parallel input to arbitration, never a gate | Anomaly detector decides whether the classifier runs | A component trained only on normal data has no evidence to judge known-vs-unknown; gating on it risked suppressing detection entirely on a false negative (§3.3) |
| Named, specific classical algorithms (robust Mahalanobis scoring; L2-logistic regression per fault type) | Deep learning; unnamed "traditional ML" | Concrete, auditable, validated algorithms suited to the actual data volume, computationally cheap enough to run un-gated on every reading (§8.1, §9.1) |
| Derived, tiered data-sufficiency policy (Insufficient/Provisional/Validated, with shown sample-size math) | An assumed, unsupported "100-200 cases" figure | Replaces an unjustified number with a shown calculation, explicit units (independent episodes, not windows), and defined system behavior at every tier (§6.2) |
| Episodes, not readings or windows, as the unit of independent evidence | Counting overlapping windows within one event as independent samples | Windows within one episode are correlated observations of the same occurrence, not independent confirmations (§6.1) |
| McNemar's paired test at α=0.10, with an explicit data-sufficiency floor below which auto-promotion is disallowed | Comparing point estimates alone, or a standard two-proportion test | Appropriate for small paired samples; the floor prevents promotion decisions the test lacks the power to make reliably (§14.2, §14.3) |
| Settling-time-parameterized precursor/active/recovery windows | A fixed, asset-specific window duration | Generalizes across asset types using each channel's own measured dynamics rather than a hardcoded number (§7.1), while still giving a concrete, derivable duration |
| Stratified negative sampling with class weighting, decoupled from the production threshold | Training only on fault-window data | Prevents the classifier from ever seeing only positive examples, and prevents the constructed training ratio from distorting the production alert rate (§6.3) |
| No dependency on a future upgrade to deep learning | Presenting deep learning as a planned future step the design relies on | Every requirement is met by the specified classical components today; any future escalation is optional and evidence-gated per class (§3.6, §9.1) |

---

## 21. References

Statistical methods used directly in this design:

- **McNemar (1947)** — paired-sample test for comparing two classifiers on the same held-out
  data, used in §14.2 for regression testing between a candidate and the currently-deployed
  detector.
- Standard normal-approximation sample-size formula for estimating a binomial proportion
  (recall / false-positive rate) within a target margin of error and confidence level, used in
  §6.2.
- **Rousseeuw & Van Driessen (1999), the Minimum Covariance Determinant estimator** — the
  robust covariance estimation method underlying the anomaly detector (§8.1).
- **Liu, Ting & Zhou (2008), Isolation Forest** — the documented escalation alternative for
  anomaly detection (§8.1).

Industrial platforms and practice (cited to support specific architectural choices, not as
product descriptions):

- **Siemens Senseye** — separates anomaly detection from classification into distinct stages,
  supporting the case for a hybrid, non-monolithic architecture (§3.3).
- **IBM Maximo Predict** — treats deployment, monitoring, and retraining as decoupled, planned
  lifecycle phases with technician feedback in the work-order flow, supporting periodic
  (not continuous) retraining and the human verification workflow (§11, §12).
- **C3 AI Reliability, ABB Ability Genix, Schneider Electric EcoStruxure** — asset performance
  management platforms built on a unified, asset-agnostic data model, supporting the
  channel-role schema (§17).

Standards:

- **ISO 13374** — reference architecture for condition monitoring and diagnostics, the basis
  for this design's overall layering.
- **ISO 17359** — general guidelines for condition-monitoring and diagnostics programs.

Academic literature:

- Open-set recognition — why separating "is this abnormal" from "which known type is this" is
  necessary for recognizing unseen conditions (§3.1, §3.3): "DenseHybrid: Hybrid Anomaly
  Detection for Dense Open-set Recognition"; "Qsco: A Quantum Scoring Module for Open-set
  Supervised Anomaly Detection."
- Small-data / few-shot industrial fault diagnosis — why deep models struggle with scarce,
  imbalanced industrial fault samples (§3.5): "A Few-Shot Learning Based Fault Diagnosis Model
  Using Sensors Data from Industrial Machineries."
- Continual learning / catastrophic forgetting — the general challenge of a model losing
  previously learned knowledge as it learns something new, and the motivation for this
  design's structural-isolation approach as an alternative to purely statistical mitigation
  (§3.4, §13): "A Continual Learning Survey: Defying Forgetting in Classification Tasks," IEEE
  TPAMI.
