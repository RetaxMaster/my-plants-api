import { Module } from '@nestjs/common';
import { OpenMeteoClient } from './open-meteo.client.js';
import { OpenMeteoGeocodingClient } from './open-meteo.geocoding.client.js';
import { WeatherService } from './weather.service.js';

@Module({
  providers: [OpenMeteoClient, OpenMeteoGeocodingClient, WeatherService],
  exports: [WeatherService, OpenMeteoGeocodingClient],
})
export class WeatherModule {}
