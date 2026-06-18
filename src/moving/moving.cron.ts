import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MovingService } from './moving.service.js';

@Injectable()
export class MovingCron {
  constructor(private readonly moving: MovingService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM) // before the 5 AM care-plan recompute
  async daily(): Promise<void> {
    await this.moving.applyDueMoves();
  }
}
