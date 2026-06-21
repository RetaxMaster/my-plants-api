import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { MovingService } from '../moving/moving.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';

// The app runs locally and is turned on to be used. On boot: apply any move whose date arrived while
// the app was off, then — ONLY if no move was applied — recompute the whole garden (applyDueMoves
// already recomputes when it applies a move). Mirrors the 05:00 cron, which stays.
@Injectable()
export class StartupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupService.name);

  constructor(
    private readonly moving: MovingService,
    private readonly carePlan: CarePlanService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const applied = await this.moving.applyDueMoves(new Date());
    if (applied === 0) {
      await this.carePlan.recomputeAll();
      this.logger.log('Startup recompute: applied 0 due moves, recomputed the whole garden.');
    } else {
      this.logger.log(`Startup recompute: applied ${applied} due move(s) (garden recomputed by the move).`);
    }
  }
}
