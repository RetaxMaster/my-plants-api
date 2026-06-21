import { Module } from '@nestjs/common';
import { WeatherModule } from '../weather/weather.module.js';
import { CitiesController } from './cities.controller.js';
import { CitiesService } from './cities.service.js';

@Module({
  imports: [WeatherModule],
  controllers: [CitiesController],
  providers: [CitiesService],
  exports: [CitiesService],
})
export class CitiesModule {}
