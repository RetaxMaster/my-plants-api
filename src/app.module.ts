import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from './config/config.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { OwnerModule } from './owner/owner.module.js';
import { SpeciesModule } from './species/species.module.js';
import { CitiesModule } from './cities/cities.module.js';
import { PlacesModule } from './places/places.module.js';
import { PlantsModule } from './plants/plants.module.js';
import { WeatherModule } from './weather/weather.module.js';
import { CarePlanModule } from './care-plan/care-plan.module.js';
import { FeedbackModule } from './feedback/feedback.module.js';
import { MovingModule } from './moving/moving.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { StartupModule } from './startup/startup.module.js';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    OwnerModule,
    ScheduleModule.forRoot(),
    SpeciesModule,
    CitiesModule,
    PlacesModule,
    PlantsModule,
    WeatherModule,
    CarePlanModule,
    FeedbackModule,
    MovingModule,
    NotificationsModule,
    StartupModule,
  ],
})
export class AppModule {}
