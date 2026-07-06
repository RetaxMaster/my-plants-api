import { Module } from '@nestjs/common';
import { CarePlanModule } from '../care-plan/care-plan.module.js';
import { WeatherModule } from '../weather/weather.module.js';
import { ImageUploadModule } from '../storage/image-upload.module.js';
import { PlantsController } from './plants.controller.js';
import { PlantsService } from './plants.service.js';

@Module({
  imports: [CarePlanModule, WeatherModule, ImageUploadModule],
  controllers: [PlantsController],
  providers: [PlantsService],
  exports: [PlantsService],
})
export class PlantsModule {}
