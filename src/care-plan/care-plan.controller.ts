import { Controller, Get, Post } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { CarePlanService } from './care-plan.service.js';

@Controller('care-plan')
export class CarePlanController {
  constructor(private readonly carePlan: CarePlanService, private readonly owner: OwnerService) {}

  @Get('today')
  async today() {
    return this.carePlan.todaysTasks(await this.owner.currentOwnerId());
  }

  @Post('recompute')
  async recompute() {
    await this.carePlan.recomputeAll();
    return { ok: true };
  }
}
