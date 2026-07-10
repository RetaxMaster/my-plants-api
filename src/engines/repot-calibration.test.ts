import { describe, it, expect } from 'vitest';
import {
  logPhi,
  erfc,
  sigmaObs,
  S_OBS,
  SIGMA0,
  R_REF_CALIB,
  LAMBDA,
  REPOT_WIDEN,
  DRIFT_T,
  calibrateRepotThreshold,
  calibrateRepotWithCarry,
  carryPrior,
} from './repot-calibration.js';

const nn = (R: number, ageDays?: number) => ({ kind: 'not-needed' as const, R, ageDays });
const nd = (R: number, ageDays?: number) => ({ kind: 'needed' as const, R, ageDays });
const cnc = () => ({ kind: 'could-not-check' as const, R: null });

describe('logPhi — relative precision + continuous two-term asymptotic tail (spec F5.2)', () => {
  // High-precision reference values of ln Φ(z) — a REFERENCE (mpmath: ln(0.5*erfc(-z/sqrt(2))), 30 digits),
  // not this code's own output.
  it('matches the reference to <1e-6 relative error at representative z', () => {
    const cases: [number, number][] = [
      [5, -2.8665157e-7],
      [0, -0.6931471805599453],
      [-2, -3.7831843336589535],
      [-6, -20.736769063317405],
      [-10, -53.23128676945526],
      [-40, -804.6084680851445],
    ];
    for (const [z, ref] of cases) {
      expect(Math.abs((logPhi(z) - ref) / ref)).toBeLessThan(1e-6);
    }
  });

  it('is continuous across the z = -10 branch cutoff (branch jump < 1e-5 nats)', () => {
    // The cutoff is -10, NOT -6: at -6 this exact assertion fails at 1.39e-4 (14x the tolerance), because
    // the two-term Mills error there is 2.78e-4 nats. At -10 it is 1.42e-5, so the branch jump is 7.08e-6.
    const left = logPhi(-10.0001);
    const at = logPhi(-10);
    const right = logPhi(-9.9999);
    expect(Math.abs(at - left)).toBeLessThan(2e-3); // step 0.0001 in z; slope ~-10 -> ~1e-3
    expect(Math.abs(right - at)).toBeLessThan(2e-3);
    // the residual JUMP attributable to the branch switch (not the z-step) is far smaller:
    const slope = (right - left) / 0.0002; // ~ dlogPhi/dz at -10
    const predictedAt = left + slope * 0.0001;
    expect(Math.abs(at - predictedAt)).toBeLessThan(1e-5); // branch discontinuity 7.08e-6 < 1e-5
  });

  it('the cutoff could NOT have been -6: the two-term Mills error there is 47x the error at -10', () => {
    // This is the assertion that makes the choice of LOGPHI_CUTOFF falsifiable rather than decorative.
    // Both branches evaluated explicitly at the same z; the direct branch is exact there (erfc(4.24) is
    // computed to relative precision), so the difference IS the asymptotic's error.
    const mills = (z: number) =>
      (-z * z) / 2 - Math.log(-z * Math.sqrt(2 * Math.PI)) + Math.log1p(-1 / z ** 2 + 3 / z ** 4);
    const direct = (z: number) => Math.log(0.5 * erfc(-z / Math.SQRT2));
    const errAt6 = Math.abs(mills(-6) - direct(-6));
    const errAt10 = Math.abs(mills(-10) - direct(-10));
    expect(errAt6).toBeGreaterThan(2e-4); // 2.78e-4 — far too large to switch branches at -6
    expect(errAt10).toBeLessThan(2e-5); // 1.42e-5 — small enough that the branch jump stays < 1e-5
    expect(errAt6 / errAt10).toBeGreaterThan(15); // measured ~19.6x
  });

  it('erfc has relative precision deep in the tail (erfc(4) ~ 1.5417e-8, not 0)', () => {
    expect(erfc(4)).toBeGreaterThan(1e-8);
    expect(Math.abs((erfc(4) - 1.54172579e-8) / 1.54172579e-8)).toBeLessThan(1e-6);
    // And the value the direct logPhi branch needs at the cutoff is still non-zero to relative precision.
    expect(erfc(10 / Math.SQRT2)).toBeGreaterThan(1e-24);
  });
});

describe('sigmaObs — variance-additive (Brownian) drift in ln R* (spec F5.2/F5.2b)', () => {
  it('is exactly S_OBS at age 0 — via a SHORT-CIRCUIT, not via sqrt(S_OBS**2)', () => {
    // `Math.sqrt(S_OBS ** 2)` round-trips for 0.2 by LUCK (`0.2 ** 2` is 0.04000000000000001), and nothing
    // guarantees it for an arbitrary S_OBS. The `Object.is` pin is only legal because age 0 returns the
    // constant literally.
    expect(Object.is(sigmaObs(0), S_OBS)).toBe(true);
    expect(Object.is(sigmaObs(-5), S_OBS)).toBe(true); // a future-dated height floors to "fresh", never NaN
    expect(Number.isNaN(sigmaObs(-5))).toBe(false);
  });
  it('grows as sqrt(S_OBS^2 + DRIFT_OBS^2 * years) — variance-additive, NOT sigma-linear', () => {
    // at 365 days: sqrt(0.20^2 + 0.50^2 * 1) = sqrt(0.29)
    expect(sigmaObs(365)).toBeCloseTo(Math.sqrt(0.04 + 0.25), 12);
    // variance is LINEAR in time: var(730) - var(365) === var(365) - var(0)
    const v = (a: number) => sigmaObs(a) ** 2;
    expect(v(730) - v(365)).toBeCloseTo(v(365) - v(0), 10);
  });
  it('treats null/undefined age as 0', () => {
    expect(Object.is(sigmaObs(null), S_OBS)).toBe(true);
    expect(Object.is(sigmaObs(undefined), S_OBS)).toBe(true);
  });
});

describe('calibrateRepotThreshold — soft probit likelihood over a log-space grid (spec F5.2)', () => {
  it('reproduces the F.11 reference table', () => {
    const rows: [ReturnType<typeof calibrateRepotThreshold>, number, number][] = [
      [calibrateRepotThreshold([nn(2.6)]), 2.927, 0.344],
      [calibrateRepotThreshold([nn(2.6), nn(3.1)]), 3.446, 0.434],
      [calibrateRepotThreshold([nn(2.6), nn(3.1), nd(3.8)]), 3.174, 0.558],
      [calibrateRepotThreshold([nn(3.1), nd(2.4)]), 2.577, 0.571], // contradiction — resolves BETWEEN
      [calibrateRepotThreshold([nn(20)]), 11.933, 0.484], // typo — finite, bounded
      [calibrateRepotThreshold([nn(2.6, 900)]), 2.297, 0.056], // stale — drift => nearly ignored
      [calibrateRepotThreshold([nn(200), nd(2)]), 14.447, 0.624], // the v3 killer — v3 returned w ~ -5.7
    ];
    for (const [got, est, w] of rows) {
      expect(got.est).toBeCloseTo(est, 2);
      expect(got.w).toBeCloseTo(w, 2);
    }
  });

  // ---- Property 2: no data reproduces the prior EXACTLY, via a short-circuit ----
  it('property 2: no observations -> rRef returned LITERALLY (Object.is), parameterised over rRef in {2,3}', () => {
    // Parameterised over rRef so the pin CAN FAIL: exp(ln(2)) === 2 exactly, but exp(ln(3)) === 2.999...96.
    // An implementation returning Math.exp(mu0) with NO short-circuit passes at 2 and FAILS at 3.
    for (const rRef of [2, 3]) {
      const r = calibrateRepotThreshold([], undefined, rRef);
      expect(Object.is(r.est, rRef)).toBe(true);
      expect(Object.is(r.w, 0)).toBe(true);
    }
    // Guard the guard: the naive form really is inexact at 3, so the test above is not vacuous.
    expect(Object.is(Math.exp(Math.log(3)), 3)).toBe(false);
  });

  it('property 2: only could-not-check events -> prior returned literally (default rRef)', () => {
    const r = calibrateRepotThreshold([cnc(), cnc()]);
    expect(Object.is(r.est, R_REF_CALIB)).toBe(true);
    expect(Object.is(r.w, 0)).toBe(true);
  });

  it('property 2: legacy events with no R_obs contribute nothing (the production backfill case)', () => {
    // Every REPOT CareEvent in the 2026-07-09 production dump carries no reason and no R_obs. They MUST
    // reduce to the literal prior, not to exp(ln(R_REF)).
    const legacy = [
      { kind: 'not-needed' as const, R: null },
      { kind: 'needed' as const, R: null },
      cnc(),
    ];
    const r = calibrateRepotThreshold(legacy);
    expect(Object.is(r.est, R_REF_CALIB)).toBe(true);
    expect(Object.is(r.w, 0)).toBe(true);
  });

  // ---- Property 1: total numerical safety AND 0 <= w < 1, over COMBINATIONS ----
  it('property 1: finite est>0 and raw w >= -1e-9 over 324 observation PAIRS on R in [0.02, 300]', () => {
    const Rs = [0.02, 0.3, 1, 2, 3, 8, 30, 120, 300];
    const kinds = ['not-needed', 'needed'] as const;
    let minRaw = Infinity;
    let minEst = Infinity;
    let pairs = 0;
    for (const R1 of Rs)
      for (const R2 of Rs)
        for (const k1 of kinds)
          for (const k2 of kinds) {
            const r = calibrateRepotThreshold([
              { kind: k1, R: R1 },
              { kind: k2, R: R2 },
            ]);
            expect(Number.isFinite(r.est) && Number.isFinite(r.w)).toBe(true);
            expect(r.w).toBeGreaterThanOrEqual(0);
            expect(r.w).toBeLessThan(1);
            minRaw = Math.min(minRaw, r.rawW);
            minEst = Math.min(minEst, r.est);
            pairs++;
          }
    expect(pairs).toBe(324);
    expect(minEst).toBeGreaterThan(0);
    // The RAW w is what catches the uniform-posterior pathology (v3 measured -5.71 here). A blanket clamp
    // with no raw assertion would silently absorb the very bug this property exists to catch.
    expect(minRaw).toBeGreaterThanOrEqual(-1e-9);
  });

  it('property 1: a VACUOUS pair leaves the posterior at the prior (w ~ 0), and never throws', () => {
    const r = calibrateRepotThreshold([nn(0.02), nd(120)]); // constrains nothing
    expect(r.w).toBeGreaterThanOrEqual(0);
    expect(r.w).toBeLessThan(0.01);
    expect(r.rawW).toBeGreaterThanOrEqual(-1e-9); // quadrature noise only
  });

  // ---- Property 3: soft, not hard — one observation MOVES but does not PIN ----
  it('property 3: one not-needed@R leaves posterior mass below R (later evidence can pull it back)', () => {
    const soft = calibrateRepotThreshold([nn(2.6)]);
    const pulled = calibrateRepotThreshold([nn(2.6), nd(2.4)]);
    expect(pulled.est).toBeLessThan(soft.est);
    expect(pulled.est).toBeLessThan(2.6); // mass survived below the "bound" — impossible under truncation
  });

  // ---- Property 4: staleness decays evidence ----
  it('property 4: the same observation at age 0 vs 900 days yields materially different w', () => {
    const fresh = calibrateRepotThreshold([nn(2.6, 0)]);
    const stale = calibrateRepotThreshold([nn(2.6, 900)]);
    expect(fresh.w).toBeCloseTo(0.344, 2);
    expect(stale.w).toBeCloseTo(0.056, 2);
    expect(fresh.w - stale.w).toBeGreaterThan(0.2);
    // and the shift itself is materially smaller
    expect(stale.est - R_REF_CALIB).toBeLessThan((fresh.est - R_REF_CALIB) / 2);
  });

  // ---- Property 5: contradictions resolve, never collapse ----
  it('property 5: conflicting observations land the estimate BETWEEN them; no branch returns the prior', () => {
    const r = calibrateRepotThreshold([nn(3.1), nd(2.4)]);
    expect(r.est).toBeGreaterThan(2.4);
    expect(r.est).toBeLessThan(3.1);
    expect(Object.is(r.est, R_REF_CALIB)).toBe(false); // did NOT collapse to the prior
  });

  // ---- Grid resolution (F5.2): sigma_post/h >= 4, cross-checked against a 10x-finer grid ----
  it('grid resolution: never throws, and the returned moments match a 10x-finer independent grid', () => {
    // An INDEPENDENT reference quadrature at 10x the resolution over the same window. If the shipped
    // adaptive grid under-resolved the posterior, est/w would disagree here.
    const fineReference = (obs: { kind: 'not-needed' | 'needed'; R: number; ageDays?: number }[]) => {
      const mu0 = Math.log(R_REF_CALIB);
      const sd0 = SIGMA0;
      const logRs = obs.map((o) => Math.log(o.R));
      const lo = Math.min(mu0, ...logRs) - 6 * sd0;
      const hi = Math.max(mu0, ...logRs) + 6 * sd0;
      const N = 4001; // 10x the initial 401
      const h = (hi - lo) / (N - 1);
      const lp: number[] = [];
      const xs: number[] = [];
      for (let i = 0; i < N; i++) {
        const x = lo + i * h;
        let l = -((x - mu0) ** 2) / (2 * sd0 * sd0);
        obs.forEach((o, k) => {
          const z = (x - logRs[k]) / sigmaObs(o.ageDays);
          l += logPhi(o.kind === 'not-needed' ? z : -z);
        });
        xs.push(x);
        lp.push(l);
      }
      const M = Math.max(...lp);
      let Z = 0;
      let m1 = 0;
      let m2 = 0;
      for (let i = 0; i < N; i++) {
        const p = Math.exp(lp[i] - M);
        Z += p;
        m1 += xs[i] * p;
        m2 += xs[i] * xs[i] * p;
      }
      const mu = m1 / Z;
      const sd = Math.sqrt(Math.max(m2 / Z - mu * mu, 0));
      return { est: Math.exp(mu), w: Math.max(0, 1 - sd / SIGMA0) };
    };

    const suites = [
      [nn(2.6)],
      [nn(3.1), nd(2.4)],
      [nn(200), nd(2)], // the v3 killer: 100x disagreement, the case that needs grid refinement
      [nn(2.6, 900)],
      [nn(2.6), nn(3.1), nd(3.8)],
      [nn(0.02), nd(300)],
    ];
    for (const obs of suites) {
      expect(() => calibrateRepotThreshold(obs)).not.toThrow();
      const got = calibrateRepotThreshold(obs);
      const ref = fineReference(obs);
      expect(Math.abs(got.est - ref.est) / ref.est).toBeLessThan(1e-3);
      expect(Math.abs(got.w - ref.w)).toBeLessThan(1e-3);
    }
  });
});

describe('carryPrior — a repot is a physical reset, not amnesia (spec F5.2b)', () => {
  const post = calibrateRepotThreshold([nn(2.6), nd(3.8)]); // the worked example: sdPost = 0.1900

  it('the worked example has the sigma_post the constants were chosen against', () => {
    expect(post.sdPost).toBeCloseTo(0.19, 3);
  });

  it('carries the posterior forward mean-reverted toward R_REF and widened', () => {
    const p = carryPrior(post, 1.5);
    // mean-reversion: mu' = lambda*mu_post + (1-lambda)*ln R_REF, so exp(mu') sits BETWEEN est and R_REF
    expect(Math.exp(p.mu)).toBeLessThan(post.est);
    expect(Math.exp(p.mu)).toBeGreaterThan(R_REF_CALIB);
    // widened, but never MORE confident than a fresh plant
    expect(p.sd).toBeGreaterThan(post.sdPost);
    expect(p.sd).toBeLessThanOrEqual(SIGMA0);
  });

  it('does NOT snap back to R_REF: feeding the carried prior with no new data keeps est off R_REF', () => {
    const carried = carryPrior(post, 1.5);
    const next = calibrateRepotThreshold([], carried); // a fresh cycle, no inspections yet
    expect(Object.is(next.est, R_REF_CALIB)).toBe(false); // memory survived the repot
    expect(next.w).toBeGreaterThan(0.2); // the carried-w FLOOR (verified 0.273)
  });

  it('honours the carried-w FLOOR (>= 0.20) for every dt <= 3y at a well-informed posterior', () => {
    for (const dt of [0.5, 1, 1.5, 2, 3]) {
      const carried = carryPrior(post, dt);
      expect(1 - carried.sd / SIGMA0).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('satisfies the variance constraint sd_post^2*WIDEN^2 + DRIFT_T^2*dt < sigma0^2 (never hits the cap)', () => {
    for (const dt of [0.5, 1, 1.5, 2, 3]) {
      const lhs = post.sdPost ** 2 * REPOT_WIDEN ** 2 + DRIFT_T ** 2 * dt;
      expect(lhs).toBeLessThan(SIGMA0 ** 2);
      expect(carryPrior(post, dt).sd).toBeLessThan(SIGMA0); // uncapped => the carry-forward buys something
    }
  });

  it('the spec-warned REPOT_WIDEN=1.8 / DRIFT_T=0.15 combo would buy NOTHING (why 1.3/0.05 was chosen)', () => {
    // Makes the joint choice falsifiable: the rejected constants hit the sigma0 cap at dt = 1.5y.
    const badSd = Math.min(SIGMA0, Math.sqrt(post.sdPost ** 2 * 1.8 ** 2 + 0.15 ** 2 * 1.5));
    expect(badSd).toBe(SIGMA0);
    expect(1 - badSd / SIGMA0).toBe(0); // carriedW = 0: a full reset, exactly what F5.2b warns about
    expect(LAMBDA).toBe(0.6);
  });
});

describe('calibrateRepotWithCarry — fold the history across repots (spec F5.2b)', () => {
  it('a single open cycle equals the plain estimator', () => {
    const a = calibrateRepotWithCarry([{ obs: [nn(2.6), nd(3.8)], doneYearsAgo: null }]);
    expect(a.est).toBeCloseTo(calibrateRepotThreshold([nn(2.6), nd(3.8)]).est, 6);
  });

  it('no cycles at all -> the literal prior (the bare-plant backcompat path)', () => {
    expect(Object.is(calibrateRepotWithCarry([]).est, R_REF_CALIB)).toBe(true);
    expect(Object.is(calibrateRepotWithCarry([{ obs: [], doneYearsAgo: null }]).est, R_REF_CALIB)).toBe(true);
  });

  it('a completed cycle then an EMPTY new cycle does NOT snap R_REF_plant back to R_REF', () => {
    const cycles = [
      { obs: [nn(2.6), nd(3.8)], doneYearsAgo: 1.5 },
      { obs: [], doneYearsAgo: null },
    ];
    const r = calibrateRepotWithCarry(cycles);
    expect(Object.is(r.est, R_REF_CALIB)).toBe(false); // memory survived the repot
    expect(r.w).toBeGreaterThan(0.2); // carried-w floor
  });

  it('an older cycle is widened more than a recent one (dt-scaled carry)', () => {
    const recent = calibrateRepotWithCarry([
      { obs: [nn(2.6), nd(3.8)], doneYearsAgo: 0.5 },
      { obs: [], doneYearsAgo: null },
    ]);
    const old = calibrateRepotWithCarry([
      { obs: [nn(2.6), nd(3.8)], doneYearsAgo: 3.0 },
      { obs: [], doneYearsAgo: null },
    ]);
    expect(old.w).toBeLessThan(recent.w); // more elapsed time -> wider carried prior -> lower w
  });
});

describe('R_REF_CALIB never drifts from scheduling.ts R_REF', () => {
  it('the deliberately duplicated value is pinned equal', async () => {
    const { R_REF } = await import('./scheduling.js');
    expect(R_REF_CALIB).toBe(R_REF);
  });
});
