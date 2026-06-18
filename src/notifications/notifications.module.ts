import { Module } from '@nestjs/common';
import { CarePlanModule } from '../care-plan/care-plan.module.js';
import { InAppNotificationsService } from './notifications.service.js';

@Module({ imports: [CarePlanModule], providers: [InAppNotificationsService], exports: [InAppNotificationsService] })
export class NotificationsModule {}
