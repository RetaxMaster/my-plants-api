import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type CareEventType, type Task } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { nextAdjustment } from '../engines/adaptation.js';
import { computeAdherence, type AdherencePayload } from './adherence.js';

const POSTPONE_WINDOW_DAYS = 60;

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
