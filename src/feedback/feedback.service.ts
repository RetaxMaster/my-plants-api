import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type CareEventType, type Task } from '@prisma/client';
import { UNJUSTIFIED_REPOT_REASON } from '@retaxmaster/my-plants-species-schema';
import type { GrowthHabit, RepotPostponeReason } from '@retaxmaster/my-plants-species-schema';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { isJustifiedRepotReason, nextAdjustment, nextRepotAdjustment } from '../engines/adaptation.js';
import { crowdingIndex, freshness } from '../engines/scheduling.js';
import { latestSizedHeight } from '../plants/latest-sized-height.js';
import { startOfTodayUtc } from '../common/time/local-date.js';
import { computeAdherence, type AdherencePayload } from './adherence.js';

const POSTPONE_WINDOW_DAYS = 60;

// ---- REPOT inspection constants (spec F.6/F6.4). Each has a §7.10 ledger row. ----
//
// Route an inspection to the F.5 calibration iff the height's `freshness` is at least this; otherwise send
// it to the fallback tracker. §F.6 asks that the calibration's MARGINAL authority at the threshold exceed
// what the fallback would have contributed — otherwise a nearly-stale height goes to a channel where it does
// less AND is denied the one where it would have done more.
//
// Both sides must be measured as MARGINAL EFFECTS ON THE DUE DATE OF THE PLANT BEING ROUTED. That is subtler
// than it looks, twice over:
//
//  (a) The fallback multiplier's authority is itself damped by `(1 - wc)` (F6.0a), and any plant that
//      REACHES this decision has a computable R, hence `wc = freshness > 0`. The fallback's UNDAMPED step
//      (-37.2 d on a 600-day cadence) belongs to a plant with `wc = 0` — one whose R is NOT computable, which
//      is routed to the fallback by `rObs == null` and never consults this threshold at all. Comparing
//      against it overstates the fallback and understates the calibration.
//  (b) `crowdingFactorRepot` is clamped to [0.82, 1.18]. The raw factor hits the HI edge at R ~ 1.5170 and the
//      LO edge at R ~ 2.5091, so it is clamped for R <= 1.516 and R >= 2.510 (rounded INWARD: raw(1.517) and
//      raw(2.509) are both still inside the band). A clamped plant cannot move further TOWARD the edge it
//      already sits on, so the calibration is saturated in exactly one direction: `not-needed-yet` on a
//      HI-clamped plant, `needed-cannot-now` on a LO-clamped one. The opposite direction moves freely
//      (R = 1.5 is clamped HI, yet its `needed-cannot-now` marginal at f = 0.8 is -72.6 d). Saturation is
//      DIRECTIONAL, not a property of being clamped.
//
// Measured on the NEUTRAL reference plant (R = R_REF, factor unclamped, 600-day cadence). The binding
// direction is `needed-cannot-now` (the `not-needed-yet` crossover sits far lower, at freshness 0.157):
//
//   freshness  height age   calibration marginal   fallback marginal (damped by 1-wc)   ratio
//     0.70        282 d          -55.2 d                  -11.2 d                        4.9x
//     0.60        346 d          -44.8 d                  -14.9 d                        3.0x
//     0.50        410 d          -35.5 d                  -18.6 d                        1.9x   <- ROUTE_MIN
//     0.40        474 d          -27.2 d                  -22.3 d                        1.2x
//     0.358       501 d          -23.9 d                  -23.9 d                        1.0x   <- crossover
//
// `0.5` therefore satisfies F.6 with a 1.9x margin, and reads exactly as the spec's own verbal criterion:
// *"the height is more trusted than not."* It admits heights up to ~13.5 months old.
//
// ⚠️ NO freshness threshold satisfies F.6 for EVERY plant: the crossover is state-dependent (0.358 at
// R = R_REF; 0.395 at R = 1.5; and for a plant saturated in the observed direction the calibration marginal
// is ~0, so the fallback is stronger at ANY freshness). Raising the threshold does not fix that — a saturated
// plant with freshness above the threshold is routed to the calibration whichever value we pick. `0.6` was
// implemented and then REVERTED for exactly this reason: its stated advantage did not survive measurement
// (it rescues a saturated plant only in the narrow window `f in [0.5, 0.6)`, while sending a neutral plant in
// that same window to the fallback, where it retains between 52.3% at f = 0.5 and 33.4% as f -> 0.6. The
// aggregate cannot decide it either: the WORST-case retained authority is 0 at every threshold, and the MEAN
// is flat to ~±0.04 across [0.36, 0.62] AND reverses its ordering with the weighting of the R grid).
// The honest fix is to route on the MARGINAL EFFECT itself — both marginals are computable here, at submit
// time — or to widen the band. Deferred; see docs/care-engine.md §7.11.
const REPOT_ROUTE_MIN = 0.5;

// The floor a postpone writes, per reason. A typed exhaustive record keyed by the shared vocabulary: a
// missing or misspelled slug is a compile error, and the engine never re-types a literal.
//   not-needed-yet    F6.4 — it must ALWAYS move the date. With a stale height the optional channel is
//                     exactly neutral (`optional ** 0 === 1`) and the emergent push can be zero: the owner
//                     supplies the most valuable observation the system can receive and nothing happens.
//   needed-cannot-now a short snooze — the owner will repot soon. Kept short: a late repot compounds.
//   could-not-check   remind tomorrow. Logistics, not information.
const REPOT_FLOOR_DAYS: Record<RepotPostponeReason, number> = {
  'not-needed-yet': 14,
  'needed-cannot-now': 14,
  'could-not-check': 1,
};

@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: OwnerService,
    private readonly carePlan: CarePlanService,
  ) {}

  async record(input: {
    plantId: string;
    task: Task;
    type: CareEventType;
    occurredOn: Date;
    postponeToOn?: Date;
    reason?: string; // top-level WATER feedback reason (spec B §4) — persisted into CareEvent.payload
    payload?: unknown;
  }): Promise<void> {
    // Defense in depth: PROGRESS is never a feedback event (the DTO already rejects it). Progress is
    // recorded only by ProgressService, which writes the DONE PROGRESS CareEvent directly.
    if (input.task === 'PROGRESS') throw new BadRequestException('PROGRESS is not a valid feedback task');

    // Owner-scope the write: a feedback event mutates the plant's history, schedule, overrides and
    // adaptation, so reject any plant the actor may not touch (mirrors the read path on
    // GET /plants/:id/care) before mutating. Single-row mutation: resolve { id, ...ownerFilter() }
    // (USER own-only, ADMIN any), then mutate by id.
    const owned = await this.prisma.plant.findFirst({
      where: { id: input.plantId, ...this.owner.ownerFilter() },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException(`Unknown plant: ${input.plantId}`);

    // REPOT is an INSPECTION, not a scheduled action (spec F). It has its own submit flow: snapshot the
    // observation, route it to exactly one learning channel, write a FLOOR override, and gate the fallback
    // tracker on a justified reason. It never reaches the generic path below — in particular it never
    // reaches the un-gated `adapt()`, which is the F1.2 fix.
    if (input.task === 'REPOT') {
      await this.recordRepotFeedback(input);
      await this.carePlan.recomputePlant(input.plantId);
      return;
    }

    // DONE-on-WATER closes a punctuality cycle (spec A.2). Capture adherence BEFORE any write —
    // an active override here is precisely the "this cycle was postponed" signal; deleting it first
    // would make every cycle look eligible (the double-count A.1 forbids).
    let adherence: AdherencePayload | null = null;
    if (input.type === 'DONE' && input.task === 'WATER') {
      // (1) read previousAnchor, current scheduled due, and whether an override is active.
      const previous = await this.prisma.careEvent.findFirst({
        where: { plantId: input.plantId, task: 'WATER', type: 'DONE' },
        orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
        select: { occurredOn: true },
      });
      const previousAnchor = previous?.occurredOn ?? (await this.prisma.plant.findUniqueOrThrow({
        where: { id: input.plantId },
        select: { acquiredOn: true },
      })).acquiredOn;
      const dueRow = await this.prisma.dueCache.findUnique({
        where: { plantId_task: { plantId: input.plantId, task: 'WATER' } },
        select: { nextDueOn: true },
      });
      const hadOverride = (await this.prisma.taskOverride.count({
        where: { plantId: input.plantId, task: 'WATER' },
      })) > 0;
      // (2) compute observed/scheduled days + eligibility.
      adherence = computeAdherence({
        occurredOn: input.occurredOn,
        previousAnchor,
        scheduledDueOn: dueRow?.nextDueOn ?? null,
        hadOverride,
      });
    }

    // (3) create the event, merging adherence into the client payload (keeps previousAnchor
    //     uncontaminated by this new event because we read it in step 1).
    const base = {
      ...(input.payload as Record<string, unknown> | undefined),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(adherence !== null ? { adherence } : {}),
    };
    const mergedPayload = Object.keys(base).length > 0 ? base : undefined;
    await this.prisma.careEvent.create({
      data: {
        plantId: input.plantId,
        task: input.task,
        type: input.type,
        occurredOn: input.occurredOn,
        ...(mergedPayload === undefined
          ? {}
          : { payload: mergedPayload as Prisma.InputJsonValue }),
      },
    });

    if (input.type === 'DONE') {
      // (4) delete the override (existing DONE behaviour).
      await this.prisma.taskOverride.deleteMany({ where: { plantId: input.plantId, task: input.task } });
      // WATER cadence learning now derives from the last-10 reason/symptom window in recomputePlant
      // (spec B §3.3/§3.4) — no PlantTaskAdjustment write here anymore.
    }

    if (input.type === 'POSTPONED' && input.postponeToOn) {
      await this.prisma.taskOverride.upsert({
        where: { plantId_task: { plantId: input.plantId, task: input.task } },
        create: { plantId: input.plantId, task: input.task, nextDueOn: input.postponeToOn },
        update: { nextDueOn: input.postponeToOn },
      });
      // Non-water Postpone keeps today's behaviour (spec B non-goal). WATER postpones learn via the
      // reason window in recomputePlant, so they do NOT nudge the raw multiplier here.
      if (input.task !== 'WATER') await this.adapt(input.plantId, input.task);
    }

    // (6) recompute the plant (existing behaviour).
    await this.carePlan.recomputePlant(input.plantId);
  }

  // Snapshot the observation AS IT IS NOW (spec F5.3). `R_obs` lives in habit-normalized space, the same
  // space `R_REF ≈ 2` is defined in, and is persisted alongside the raw inputs that produced it — because
  // `growthHabit` is a user-editable profile field, so persisting only the ratio would let an edit from
  // `shrub` to `climber` silently rewrite the meaning of the whole observation history. The height and its
  // measurement day come from `latestSizedHeight`, the single definition of "the plant's height"; this flow
  // must not re-implement that query (a later note-only progress entry must never blank a real height).
  private async snapshotRepotObservation(plantId: string, now: Date) {
    const [profile, sized] = await Promise.all([
      this.prisma.plantProfile.findUnique({
        where: { plantId },
        select: { potSizeCm: true, growthHabit: true },
      }),
      latestSizedHeight(this.prisma, plantId, now),
    ]);
    const heightCm = sized?.heightCm ?? null;
    const potSizeCm = profile?.potSizeCm ?? null;
    const growthHabit = (profile?.growthHabit ?? null) as GrowthHabit | null;
    const heightMeasuredOn = sized?.measuredOn ?? null;
    const rObs = crowdingIndex(heightCm, potSizeCm, growthHabit); // null when R is not computable
    // `fresh` is 0 whenever R is not computable — no pot size, no height, or a trailing habit. Those
    // inspections have no physical channel to enter, so they take the fallback (Spec E A5.4's `wc`).
    const fresh = rObs != null ? freshness(sized?.heightAgeDays ?? 0) : 0;
    return { rObs, heightCm, potSizeCm, growthHabit, heightMeasuredOn, fresh };
  }

  // The full REPOT inspection flow (both DONE and POSTPONED). A DONE re-anchors (its `occurredOn`) and
  // clears the override; a POSTPONED captures the reason, snapshots the observation, decides the routing,
  // writes a FLOOR override, and — ONLY on the fallback route and ONLY for a justified reason — nudges the
  // quantile tracker. `could-not-check` never moves the multiplier: that is the F1.2 fix.
  private async recordRepotFeedback(input: {
    plantId: string;
    type: CareEventType;
    occurredOn: Date;
    reason?: string;
    payload?: unknown;
  }): Promise<void> {
    // Guard the HTTP edge: REPOT feedback is ONLY DONE or POSTPONED. The DTO accepts any CareEventType
    // (@IsEnum), so without this a { task: 'REPOT', type: 'SYMPTOM' } would FALL THROUGH to the POSTPONED
    // path below and be persisted with the wrong type, an invented reason, and a floor override — silent
    // data corruption.
    if (input.type !== 'DONE' && input.type !== 'POSTPONED') {
      throw new BadRequestException(`REPOT feedback must be DONE or POSTPONED, got ${input.type}`);
    }
    const now = new Date();
    const snap = await this.snapshotRepotObservation(input.plantId, now);
    const basePayload = {
      ...(input.payload as Record<string, unknown> | undefined),
      R_obs: snap.rObs,
      heightCm: snap.heightCm,
      potSizeCm: snap.potSizeCm,
      growthHabit: snap.growthHabit,
      heightMeasuredOn: snap.heightMeasuredOn ? snap.heightMeasuredOn.toISOString() : null,
    };

    if (input.type === 'DONE') {
      // A DONE snapshots the payload for audit but is NEVER a calibration observation: a preventive or
      // merely scheduled repot would enter the estimate as a false `needed` and poison it (F.10 item 4).
      // `routedTo: 'done'` makes the calibration's `routedTo === 'calibration'` filter exclude it
      // structurally, rather than relying on the absence of a `reason`.
      await this.prisma.careEvent.create({
        data: {
          plantId: input.plantId,
          task: 'REPOT',
          type: 'DONE',
          occurredOn: input.occurredOn,
          payload: { ...basePayload, routedTo: 'done' } as Prisma.InputJsonValue,
        },
      });
      await this.prisma.taskOverride.deleteMany({ where: { plantId: input.plantId, task: 'REPOT' } });
      return;
    }

    // POSTPONED — an inspection. An absent or foreign reason (e.g. a WATER slug the coarse DTO allows)
    // defaults to the UNJUSTIFIED outcome, which is the safe one: it records nothing. The vocabulary is
    // referenced by name from the shared schema, never re-typed.
    const reason: RepotPostponeReason =
      input.reason != null && isJustifiedRepotReason(input.reason)
        ? (input.reason as RepotPostponeReason)
        : UNJUSTIFIED_REPOT_REASON;
    const justified = isJustifiedRepotReason(reason);
    // The split is by FRESHNESS, not mere existence. A height recorded two years ago yields an `R_obs` that
    // exists but whose authority has decayed to nothing; routing it to the calibration would give it no
    // effect AND deny it the fallback, so it would contribute to neither channel.
    const routedTo: 'calibration' | 'adjustment' =
      justified && snap.rObs != null && snap.fresh >= REPOT_ROUTE_MIN ? 'calibration' : 'adjustment';

    await this.prisma.careEvent.create({
      data: {
        plantId: input.plantId,
        task: 'REPOT',
        type: 'POSTPONED',
        occurredOn: input.occurredOn,
        payload: { ...basePayload, reason, routedTo } as Prisma.InputJsonValue,
      },
    });

    // The floor date (F6.4 / F3.1). `resolveDue` applies it as `max(computed, override)`, so a snooze can
    // only ever push FORWARD; it can never pin.
    //
    // CRITICAL: `TaskOverride.nextDueOn` is `@db.Date` (DAY granularity). Build a UTC-MIDNIGHT date from the
    // plant's local "today" the way the rest of the engine does — never `Date.now() + N * 86_400_000`, which
    // carries the current wall-clock time, truncates on insert, and lands on a day that depends on the
    // session timezone (the MariaDB date rule).
    const tz = (
      await this.prisma.plant.findUniqueOrThrow({
        where: { id: input.plantId },
        select: { place: { select: { city: { select: { timezone: true } } } } },
      })
    ).place.city.timezone;
    const today = startOfTodayUtc(tz, now);
    const pushDays = REPOT_FLOOR_DAYS[reason];
    const floorOn = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + pushDays),
    );
    await this.prisma.taskOverride.upsert({
      where: { plantId_task: { plantId: input.plantId, task: 'REPOT' } },
      create: { plantId: input.plantId, task: 'REPOT', nextDueOn: floorOn },
      update: { nextDueOn: floorOn },
    });

    // The fallback tracker: ONLY when routed to `adjustment` AND the reason is justified. A
    // calibration-routed event leaves the multiplier alone — exclusivity is decided here, at submit time,
    // and persisted as `payload.routedTo`, because the calibration re-reads the whole event history on
    // every recompute and would otherwise consume this event through the second channel as well.
    if (routedTo === 'adjustment' && justified) {
      const current =
        (
          await this.prisma.plantTaskAdjustment.findUnique({
            where: { plantId_task: { plantId: input.plantId, task: 'REPOT' } },
          })
        )?.multiplier ?? 1;
      const multiplier = nextRepotAdjustment(current, reason);
      await this.prisma.plantTaskAdjustment.upsert({
        where: { plantId_task: { plantId: input.plantId, task: 'REPOT' } },
        create: { plantId: input.plantId, task: 'REPOT', multiplier },
        update: { multiplier },
      });
    }
  }

  // The generic, un-gated adaptation. REPOT no longer reaches it (see `record`). It now serves only
  // FERTILIZE / ROTATE / CLEAN_LEAVES / MIST, which still carry the F1.2 defect — named, scheduled
  // separately, and deliberately out of Spec F's scope.
  private async adapt(plantId: string, task: Task): Promise<void> {
    const since = new Date(Date.now() - POSTPONE_WINDOW_DAYS * 86_400_000);
    const recentPostpones = await this.prisma.careEvent.count({
      where: { plantId, task, type: 'POSTPONED', occurredOn: { gte: since } },
    });
    const current = (await this.prisma.plantTaskAdjustment.findUnique({
      where: { plantId_task: { plantId, task } },
    }))?.multiplier ?? 1;
    const multiplier = nextAdjustment({ current, recentPostpones, earlyLateRatio: 1 });
    await this.prisma.plantTaskAdjustment.upsert({
      where: { plantId_task: { plantId, task } },
      create: { plantId, task, multiplier },
      update: { multiplier },
    });
  }
}
