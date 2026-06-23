import { Controller, Get, Post } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { CarePlanService } from './care-plan.service.js';

@Controller('care-plan')
export class CarePlanController {
  constructor(private readonly carePlan: CarePlanService, private readonly owner: OwnerService) {}

  @Get('today')
  async today() {
    return this.carePlan.todaysTasks(this.owner.currentOwnerId());
  }

  // Scopes to the EFFECTIVE owner (own by default; the target when acting-as). The all-owners
  // recompute remains available only via the startup/cron job, never over HTTP.
  @Post('recompute')
  async recompute() {
    await this.carePlan.recomputeOwner(this.owner.currentOwnerId());
    return { ok: true };
  }
}
