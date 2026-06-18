import { Module } from '@nestjs/common';
import { WeatherModule } from '../weather/weather.module.js';
import { CarePlanController } from './care-plan.controller.js';
import { CarePlanCron } from './care-plan.cron.js';
import { CarePlanService } from './care-plan.service.js';

@Module({
  imports: [WeatherModule],
  controllers: [CarePlanController],
  providers: [CarePlanService, CarePlanCron],
  exports: [CarePlanService],
})
export class CarePlanModule {}
