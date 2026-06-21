import { Module } from '@nestjs/common';
import { CarePlanModule } from '../care-plan/care-plan.module.js';
import { PlantsController } from './plants.controller.js';
import { PlantsService } from './plants.service.js';

@Module({
  imports: [CarePlanModule],
  controllers: [PlantsController],
  providers: [PlantsService],
  exports: [PlantsService],
})
export class PlantsModule {}
