import { Module } from '@nestjs/common';
import { CarePlanModule } from '../care-plan/care-plan.module.js';
import { FrequencyController } from './frequency.controller.js';
import { FrequencyService } from './frequency.service.js';

@Module({
  imports: [CarePlanModule],
  controllers: [FrequencyController],
  providers: [FrequencyService],
})
export class FrequencyModule {}
