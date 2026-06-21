import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { MovingService } from '../moving/moving.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';

// The app runs locally and is turned on to be used. On boot: apply any move whose date arrived while
// the app was off (for ALL owners), then — ONLY if no move was applied — recompute the whole garden
// (applyAllDueMoves already recomputes once when it applies a move). Mirrors the 04:00 cron, which stays.
@Injectable()
export class StartupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupService.name);

  constructor(
    private readonly moving: MovingService,
    private readonly carePlan: CarePlanService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // System job at boot: apply due moves for ALL owners (no request actor here).
    const applied = await this.moving.applyAllDueMoves(new Date());
    if (applied === 0) {
      await this.carePlan.recomputeAll();
      this.logger.log('Startup recompute: applied 0 due moves, recomputed the whole garden.');
    } else {
      this.logger.log(`Startup recompute: applied ${applied} due move(s) (garden recomputed by the move).`);
    }
  }
}
