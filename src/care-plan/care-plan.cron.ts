import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CarePlanService } from './care-plan.service.js';

@Injectable()
export class CarePlanCron {
  constructor(private readonly carePlan: CarePlanService) {}

  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async daily(): Promise<void> {
    await this.carePlan.recomputeAll();
  }
}
