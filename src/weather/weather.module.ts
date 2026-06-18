import { Module } from '@nestjs/common';
import { OpenMeteoClient } from './open-meteo.client.js';
import { WeatherService } from './weather.service.js';

@Module({ providers: [OpenMeteoClient, WeatherService], exports: [WeatherService] })
export class WeatherModule {}
