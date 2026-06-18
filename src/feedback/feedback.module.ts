import { Module } from '@nestjs/common';
import { CarePlanModule } from '../care-plan/care-plan.module.js';
import { FeedbackController } from './feedback.controller.js';
import { FeedbackService } from './feedback.service.js';

@Module({ imports: [CarePlanModule], controllers: [FeedbackController], providers: [FeedbackService] })
export class FeedbackModule {}
