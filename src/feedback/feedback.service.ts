import { Injectable, Logger } from '@nestjs/common';
import type { CareEventType, Task } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { recordFeedbackCore, assertNotProgressTask } from './feedback.write-core.js';
import { runEffects } from '../common/write-effects.js';

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

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
    // Fail fast, before opening a transaction we would only roll back. The core enforces this too.
    assertNotProgressTask(input.task);

    const ownerId = this.owner.currentOwnerId();
    const { effects } = await this.prisma.$transaction((tx) =>
      recordFeedbackCore(tx, {
        ...input,
        ownerId,
        audit: { origin: 'OWNER', proposalId: null, actorUserId: this.owner.currentActor()?.userId ?? null },
      }),
    );
    await runEffects(effects, this.effectRunner());
  }

  /** Post-commit runner: a feedback write only ever asks for a care-plan recompute. */
  private effectRunner() {
    return {
      recomputePlant: (plantId: string) => this.carePlan.recomputePlant(plantId),
      deleteObject: async () => {},
      deleteInboxPaths: async () => {},
      enqueuePhotoTick: () => {},
      logger: this.logger,
    };
  }
}
