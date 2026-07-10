// ---- Spec F §F.5: the per-plant repot threshold, learned from ground truth ----------------------------
//
// Spec E's crowding prior says a plant becomes root-bound around R = R_REF ≈ 2. But the true threshold is a
// property of THIS plant. Call it R*. Every inspection is a censored observation of it: `not-needed-yet` at
// crowding R_obs says R* is probably above R_obs; `needed-cannot-now` says it is probably at or below.
//
// We work in x = ln R*, with a normal prior N(ln R_REF, σ₀²) and a SOFT (probit) likelihood per inspection.
// The likelihood is soft, not a hard bound, because R_obs is a NOISY PROXY: `heightCm` is a hand-typed Int,
// `potSizeCm` is a rim diameter carrying a documented 66 % volume error (Spec E A2.4), and the habit
// normalizer is an open item. A hard truncation would give one bad keystroke infinite authority.
//
// THREE ESTIMATORS DIED HERE ON ARITHMETIC, NOT ON THEORY. Do not "simplify" any of the following:
//   v1 geometric shrinkage      — returned answers BELOW a bound the observation had established.
//   v2 truncated-normal closed form — `Z = Φ(β) − Φ(α)` underflows; `Z = 0 → est = 0`, and feasibility
//                                     violations at R_obs ≈ 30 that its own sweep never reached.
//   v3 linear-space grid + `1e-300` clamp — silently returns a UNIFORM posterior when two observations
//                                     disagree by more than ~30×: `est = 20.0`, `w = −5.71`, and
//                                     `Number.isFinite(est) && est > 0` PASSES on that garbage.
// The cure removes each pathology instead of guarding it: relative-precision `erfc`, accumulation in LOG
// space with `max_x logp` subtracted (no `Z` denominator, no clamp), and an adaptive grid that THROWS.

// ---- Vendored erfc of RELATIVE precision (Numerical Recipes 3rd ed., `erfccheb`, |eps| ~ 1e-15). ----
// This is DELIBERATELY not Math.erf-style: an Abramowitz-Stegun erf has ABSOLUTE error 1.5e-7 and
// saturates to exactly 1.0 for |z| >~ 6, so it cannot express Phi(-6)=9.87e-10 to any significant digit.
// erfccheb keeps relative precision into the deep tail, which is what lets logPhi avoid ALL clamping.
// Coefficients copied verbatim from Numerical Recipes — do not "simplify" or regenerate them.
const ERFC_COF = [
  -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3,
  -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
  -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
  6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
  9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13,
  -1.12708e-13, 3.81e-16, 7.106e-15, -1.523e-15, -9.4e-17, 1.21e-16, -2.8e-17,
];
function erfccheb(z: number): number {
  if (z < 0) throw new Error('erfccheb requires a nonnegative argument');
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  let d = 0;
  let dd = 0;
  for (let j = ERFC_COF.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + ERFC_COF[j];
    dd = tmp;
  }
  return t * Math.exp(-z * z + 0.5 * (ERFC_COF[0] + ty * d) - dd);
}
export const erfc = (x: number): number => (x >= 0 ? erfccheb(x) : 2 - erfccheb(-x));

// ln Phi(z). Direct relative-precision branch where valid; a TWO-term asymptotic (Mills ratio) below
// z = -10. The cutoff is -10, NOT -6: the two-term error at -6 is 2.78e-4 nats (measured), so a -6 cutoff
// FAILS the branch-continuity assertion at 1.39e-4 — 14x the 1e-5 tolerance. At -10 the two-term error is
// 1.42e-5 and the branch jump is 7.08e-6. TREACHEROUS to get wrong: logPhi(-6) uses the DIRECT branch
// (exact), logPhi(-10) the tail (rel. error ~3e-8), logPhi(-40) is machine-exact — so every other logPhi
// test passes; ONLY the continuity assertion exposes a too-shallow cutoff. No clamp anywhere: the
// relative-precision erfc never underflows to a fake zero, and erfc(10/sqrt2) ~ 1.52e-23 keeps the direct
// branch valid all the way down to -10.
export const LOGPHI_CUTOFF = -10;
export function logPhi(z: number): number {
  if (z < LOGPHI_CUTOFF) {
    return (-z * z) / 2 - Math.log(-z * Math.sqrt(2 * Math.PI)) + Math.log1p(-1 / z ** 2 + 3 / z ** 4);
  }
  return Math.log(0.5 * erfc(-z / Math.SQRT2));
}

// ---- Tuned constants (each a §7.10 ledger row). Chosen against the F.11 reference table + a 324-pair
// combination sweep; every number below was verified by running the estimator. ----
export const R_REF_CALIB = 2; // CONVENTION (inherits Spec E A2.6's unmeasured-depth error, A2.4). Same
//                               numeric value as scheduling.ts's R_REF; bound here so the estimator is a
//                               self-contained, independently testable pure module. A test pins them equal.
export const SIGMA0 = 0.35; // TUNED prior sd in ln R*.
export const S_OBS = 0.2; // TUNED fresh-observation noise.
export const DRIFT_OBS = 0.5; // TUNED variance-additive drift.
const GRID_N0 = 401; // TUNED initial grid; doubles N <- 2N-1 up to GRID_MAX_PASSES.
const GRID_MAX_PASSES = 8;
const WINDOW_SIGMAS = 6; // TUNED window half-width in prior sds.
const GRID_MIN_RESOLUTION = 4; // assert sigma_post / h >= 4 (the F5.2 grid-resolution property).

// σ_obs GROWS with the observation's age — a random walk in ln R* (VARIANCE-additive), the SAME law the
// carry-forward uses (F5.2b). The retired `S_OBS + DRIFT·age/30` grew SIGMA linearly (variance ~ t²): a
// second, incompatible model of one physical drift. `age` is the HEIGHT MEASUREMENT's age, not the
// inspection event's (F5.3) — they differ exactly in the case that matters (a fresh inspection of a plant
// whose height was recorded two years ago).
export const sigmaObs = (ageDays: number | null | undefined): number =>
  Math.sqrt(S_OBS ** 2 + (DRIFT_OBS ** 2 * (ageDays ?? 0)) / 365);

// One inspection, projected from a CareEvent by the care-plan caller. `R` is the habit-normalized R_obs
// SNAPSHOTTED at inspection time (F5.3), never recomputed from current profile values. `could-not-check`
// (and any event with R == null) contributes NO likelihood factor.
export type RepotObservationKind = 'not-needed' | 'needed' | 'could-not-check';
export interface RepotObservation {
  kind: RepotObservationKind;
  R: number | null;
  ageDays?: number | null;
}
export interface CalibrationPrior {
  mu: number;
  sd: number;
}
export interface CalibrationResult {
  est: number; // R_REF_plant = exp(E[ln R*])
  w: number; // clamped confidence for the caller: max(0, 1 - sd/σ₀)
  rawW: number; // UNCLAMPED 1 - sd/σ₀ — asserted >= -1e-9 by the sweep (catches the uniform-posterior bug)
  muPost: number; // posterior mean of ln R* (fed to the carry-forward)
  sdPost: number; // posterior sd of ln R*
}

// The estimator. Prior N(ln rRef, σ₀²); each inspection a SOFT probit factor Φ(±z); could-not-check
// contributes nothing. Accumulate in LOG SPACE and subtract max_x logp — no Z in a denominator, no
// 1e-300 clamp. Short-circuit the no-data path to return rRef LITERALLY. Adaptive grid: assert
// σ_post/h >= 4, refine, and THROW after GRID_MAX_PASSES — never escape silently, never return undefined.
export function calibrateRepotThreshold(
  observations: RepotObservation[],
  prior?: CalibrationPrior,
  rRef: number = R_REF_CALIB, // injection-only: production always uses R_REF_CALIB. Exposed so the
  //                             short-circuit's literal-return property is testable at rRef = 3, where
  //                             exp(ln(rRef)) !== rRef — a value at which the pin can actually fail.
): CalibrationResult {
  const isDefaultPrior = !prior;
  const mu0 = isDefaultPrior ? Math.log(rRef) : prior.mu;
  const sd0 = isDefaultPrior ? SIGMA0 : prior.sd;
  const u = observations.filter((o) => o.R != null && (o.kind === 'not-needed' || o.kind === 'needed'));
  if (u.length === 0) {
    // SHORT-CIRCUIT: return the prior's central value literally. On the default prior that is rRef exactly
    // — never `exp(ln(rRef))`, which is 2.9999999999999996 at rRef = 3 (the Object.is trap F5.2 property 2
    // exists to catch). `w` is always measured against SIGMA0, never against a carried, narrower sd0, so a
    // post-repot plant's w is comparable with a fresh plant's.
    const rawW = 1 - sd0 / SIGMA0;
    return {
      est: isDefaultPrior ? rRef : Math.exp(mu0),
      w: Math.max(0, rawW),
      rawW,
      muPost: mu0,
      sdPost: sd0,
    };
  }
  const logRs = u.map((o) => Math.log(o.R as number));
  const lo = Math.min(mu0, ...logRs) - WINDOW_SIGMAS * sd0;
  const hi = Math.max(mu0, ...logRs) + WINDOW_SIGMAS * sd0;
  let N = GRID_N0;
  for (let pass = 0; pass < GRID_MAX_PASSES; pass++) {
    const h = (hi - lo) / (N - 1);
    const xs: number[] = new Array(N);
    const lp: number[] = new Array(N);
    for (let i = 0; i < N; i++) {
      const x = lo + i * h;
      let l = -((x - mu0) ** 2) / (2 * sd0 * sd0); // log prior
      for (let k = 0; k < u.length; k++) {
        const z = (x - logRs[k]) / sigmaObs(u[k].ageDays);
        l += logPhi(u[k].kind === 'not-needed' ? z : -z); // soft bound
      }
      xs[i] = x;
      lp[i] = l;
    }
    let M = -Infinity;
    for (let i = 0; i < N; i++) if (lp[i] > M) M = lp[i];
    let Z = 0;
    let m1 = 0;
    let m2 = 0;
    for (let i = 0; i < N; i++) {
      const p = Math.exp(lp[i] - M); // subtract the max -> no underflow, no clamp
      Z += p;
      m1 += xs[i] * p;
      m2 += xs[i] * xs[i] * p;
    }
    const mu = m1 / Z;
    const sd = Math.sqrt(Math.max(m2 / Z - mu * mu, 0));
    if (sd / h >= GRID_MIN_RESOLUTION) {
      // The window spans every observation +-6σ₀ while N is fixed, so h GROWS with observation spread
      // exactly as σ_post SHRINKS with observation count: the resolution degrades precisely when the
      // posterior sharpens. The first moment tolerates it; the second (which w is computed from) does not.
      const rawW = 1 - sd / SIGMA0;
      return { est: Math.exp(mu), w: Math.max(0, rawW), rawW, muPost: mu, sdPost: sd };
    }
    N = N * 2 - 1; // adaptive refinement
  }
  throw new Error('calibrateRepotThreshold: grid did not resolve the posterior');
}

// ---- Carry-forward constants (F5.2b). Chosen JOINTLY against the variance constraint AND a FLOOR on the
// carried w. Verified: carriedW in [0.252, 0.287] for Δt <= 3y at σ_post = 0.19; the spec-warned
// REPOT_WIDEN=1.8 / DRIFT_T=0.15 combo hits the σ₀ cap at Δt=1.5y and yields carriedW = 0 — it buys
// nothing, which is exactly the failure F5.2b warns about. ----
export const LAMBDA = 0.6; // TUNED mean-reversion toward R_REF (a repot resets time-in-pot).
export const REPOT_WIDEN = 1.3; // TUNED variance widening for the physical reset.
export const DRIFT_T = 0.05; // TUNED variance drift per elapsed year (< the 0.061 upper bound).

// The next cycle's prior = this cycle's posterior, mean-reverted toward R_REF and widened (variance-
// additive, with elapsed time), bounded by σ₀ so a carried prior is never MORE confident than a fresh
// plant's. A repot is a PHYSICAL RESET (fresh medium, pruned roots), not an amnesia event: discarding the
// history outright would snap R_REF_plant back to R_REF at the exact moment the model finally had data.
// Reversion is mandatory, not optional — F5.4 says R* FALLS with time in the pot, and a repot resets that
// clock, so R* climbs back toward R_REF. Δt = years since the repot.
export function carryPrior(post: CalibrationResult, yearsSinceRepot: number): CalibrationPrior {
  const mu = LAMBDA * post.muPost + (1 - LAMBDA) * Math.log(R_REF_CALIB);
  const sd = Math.min(
    SIGMA0,
    Math.sqrt(post.sdPost ** 2 * REPOT_WIDEN ** 2 + DRIFT_T ** 2 * yearsSinceRepot),
  );
  return { mu, sd };
}

// One REPOT cycle: the calibration observations recorded during it, and the age (in YEARS) of the REPOT
// DONE that CLOSED it — or `null` for the current, still-open cycle.
export interface RepotCycle {
  obs: RepotObservation[];
  doneYearsAgo: number | null;
}

// Fold the plant's inspection history across repots (F5.2b). Oldest cycle first. Each COMPLETED cycle
// contributes its posterior, carried forward (mean-reverted + widened by elapsed time) as the next cycle's
// prior — so a repot never erases what the plant taught us, and older evidence is progressively widened.
// The final (open) cycle's posterior against the accumulated prior IS R_REF_plant + w.
export function calibrateRepotWithCarry(cycles: RepotCycle[]): CalibrationResult {
  if (cycles.length === 0) return calibrateRepotThreshold([]);
  let prior: CalibrationPrior | undefined;
  for (let i = 0; i < cycles.length - 1; i++) {
    const post = calibrateRepotThreshold(cycles[i].obs, prior);
    prior = carryPrior(post, cycles[i].doneYearsAgo ?? 0);
  }
  return calibrateRepotThreshold(cycles[cycles.length - 1].obs, prior);
}
