import { Injectable } from '@nestjs/common';
import { Prisma, type CareEventType, type Task } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { nextAdjustment } from '../engines/adaptation.js';

const POSTPONE_WINDOW_DAYS = 60;

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService, private readonly carePlan: CarePlanService) {}

  async record(input: {
    plantId: string;
    task: Task;
    type: CareEventType;
    occurredOn: Date;
    postponeToOn?: Date;
    payload?: unknown;
  }): Promise<void> {
    await this.prisma.careEvent.create({
      data: {
        plantId: input.plantId,
        task: input.task,
        type: input.type,
        occurredOn: input.occurredOn,
        ...(input.payload === undefined
          ? {}
          : { payload: input.payload as Prisma.InputJsonValue }),
      },
    });

    if (input.type === 'DONE') {
      await this.prisma.taskOverride.deleteMany({ where: { plantId: input.plantId, task: input.task } });
    }

    if (input.type === 'POSTPONED' && input.postponeToOn) {
      await this.prisma.taskOverride.upsert({
        where: { plantId_task: { plantId: input.plantId, task: input.task } },
        create: { plantId: input.plantId, task: input.task, nextDueOn: input.postponeToOn },
        update: { nextDueOn: input.postponeToOn },
      });
      await this.adapt(input.plantId, input.task);
    }

    if (input.type === 'SYMPTOM') {
      await this.adaptForSymptom(input.plantId, input.payload);
    }

    await this.carePlan.recomputePlant(input.plantId);
  }

  // Minimal v1 symptom→watering map: over-watering signs lengthen, under-watering shorten.
  private async adaptForSymptom(plantId: string, payload: unknown): Promise<void> {
    const symptom = (payload as { symptom?: string } | undefined)?.symptom;
    const nudge: Record<string, number> = {
      'yellow-leaves-wet-soil': 0.15, // likely over-watered → water less often
      'mushy-stem': 0.2,
      'wilting-dry-soil': -0.15, // under-watered → water more often
      'crispy-edges-dry-soil': -0.1,
    };
    const delta = symptom ? nudge[symptom] : undefined;
    if (delta === undefined) return; // unknown symptom: stored as an event, no adjustment
    const current = (await this.prisma.plantTaskAdjustment.findUnique({
      where: { plantId_task: { plantId, task: 'WATER' } },
    }))?.multiplier ?? 1;
    const multiplier = Math.min(2, Math.max(0.5, current + delta));
    await this.prisma.plantTaskAdjustment.upsert({
      where: { plantId_task: { plantId, task: 'WATER' } },
      create: { plantId, task: 'WATER', multiplier },
      update: { multiplier },
    });
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
