import { Module } from '@nestjs/common';
import { MovingModule } from '../moving/moving.module.js';
import { CarePlanModule } from '../care-plan/care-plan.module.js';
import { StartupService } from './startup.service.js';

@Module({
  imports: [MovingModule, CarePlanModule],
  providers: [StartupService],
})
export class StartupModule {}
