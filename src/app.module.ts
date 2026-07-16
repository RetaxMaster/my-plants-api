import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ClsModule } from 'nestjs-cls';
import { ConfigModule } from './config/config.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { OwnerModule } from './owner/owner.module.js';
import { SpeciesModule } from './species/species.module.js';
import { CitiesModule } from './cities/cities.module.js';
import { OwnersModule } from './owners/owners.module.js';
import { PlacesModule } from './places/places.module.js';
import { PlantsModule } from './plants/plants.module.js';
import { WeatherModule } from './weather/weather.module.js';
import { CarePlanModule } from './care-plan/care-plan.module.js';
import { FeedbackModule } from './feedback/feedback.module.js';
import { ProgressModule } from './progress/progress.module.js';
import { FrequencyModule } from './frequency/frequency.module.js';
import { MovingModule } from './moving/moving.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { StartupModule } from './startup/startup.module.js';
import { ImageUploadModule } from './storage/image-upload.module.js';
import { PhotoWorkerModule } from './photo-worker/photo-worker.module.js';
import { AuthModule } from './auth/auth.module.js';
import { KnowledgeChatModule } from './knowledge-chat/knowledge-chat.module.js';
import { BlogModule } from './blog/blog.module.js';
import { MediaModule } from './media/media.module.js';

@Module({
  imports: [
    // Mounted as middleware so the per-request CLS store exists BEFORE guards run (the
    // JwtAuthGuard writes the actor into it). `global: true` makes ClsService injectable everywhere.
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    ConfigModule,
    PrismaModule,
    OwnerModule,
    ScheduleModule.forRoot(),
    SpeciesModule,
    CitiesModule,
    OwnersModule,
    PlacesModule,
    PlantsModule,
    WeatherModule,
    CarePlanModule,
    FeedbackModule,
    ProgressModule,
    FrequencyModule,
    MovingModule,
    NotificationsModule,
    StartupModule,
    ImageUploadModule,
    PhotoWorkerModule,
    AuthModule,
    KnowledgeChatModule,
    BlogModule,
    MediaModule,
  ],
})
export class AppModule {}
