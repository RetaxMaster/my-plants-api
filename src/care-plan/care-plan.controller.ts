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

  // Role-gated: an ADMIN recomputes the whole system; a USER recomputes only their own garden.
  @Post('recompute')
  async recompute() {
    if (this.owner.currentRole() === 'ADMIN') await this.carePlan.recomputeAll();
    else await this.carePlan.recomputeOwner(this.owner.currentOwnerId());
    return { ok: true };
  }
}
