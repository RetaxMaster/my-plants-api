import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import type { SetFrequencyDto } from './frequency.dto.js';
import { setFrequencyCore, clearFrequencyCore } from './frequency.write-core.js';
import { runEffects } from '../common/write-effects.js';

@Injectable()
export class FrequencyService {
  private readonly logger = new Logger(FrequencyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: OwnerService,
    private readonly carePlan: CarePlanService,
  ) {}

  async list(plantId: string) {
    await this.assertOwned(plantId);
    return this.prisma.plantTaskFrequency.findMany({
      where: { plantId },
      select: { task: true, intervalDays: true },
    });
  }

  async set(plantId: string, dto: SetFrequencyDto) {
    const { effects } = await this.prisma.$transaction((tx) =>
      setFrequencyCore(tx, {
        plantId,
        ownerId: this.owner.currentOwnerId(),
        task: dto.task,
        intervalDays: dto.intervalDays,
        audit: { origin: 'OWNER', proposalId: null, actorUserId: this.owner.currentActor()?.userId ?? null },
      }),
    );
    // The override substitution lives in the engine (Phase 2); the recompute is a post-commit effect.
    await runEffects(effects, this.effectRunner());
    return this.list(plantId);
  }

  async clear(plantId: string, task: string) {
    // The DELETE :task param is a raw string; the core validates it (no DTO on a path param).
    const { effects } = await this.prisma.$transaction((tx) =>
      clearFrequencyCore(tx, {
        plantId,
        ownerId: this.owner.currentOwnerId(),
        task,
        audit: { origin: 'OWNER', proposalId: null, actorUserId: this.owner.currentActor()?.userId ?? null },
      }),
    );
    await runEffects(effects, this.effectRunner());
    return this.list(plantId);
  }

  /** Post-commit runner: a frequency write only ever asks for a care-plan recompute. */
  private effectRunner() {
    return {
      recomputePlant: (id: string) => this.carePlan.recomputePlant(id),
      deleteObject: async () => {},
      deleteInboxPaths: async () => {},
      enqueuePhotoTick: () => {},
      logger: this.logger,
    };
  }

  private async assertOwned(plantId: string): Promise<void> {
    const owned = await this.prisma.plant.findFirst({
      where: { id: plantId, ...this.owner.ownerFilter() },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException(`Unknown plant: ${plantId}`);
  }
}
