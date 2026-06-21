import { Module } from '@nestjs/common';
import { CarePlanModule } from '../care-plan/care-plan.module.js';
import { WeatherModule } from '../weather/weather.module.js';
import { MovingController } from './moving.controller.js';
import { MovingCron } from './moving.cron.js';
import { MovingService } from './moving.service.js';

@Module({
  imports: [WeatherModule, CarePlanModule],
  controllers: [MovingController],
  providers: [MovingService, MovingCron],
  exports: [MovingService],
})
export class MovingModule {}
