import { Module } from '@nestjs/common';
import { CarePlanModule } from '../care-plan/care-plan.module.js';
import { ImageUploadModule } from '../storage/image-upload.module.js';
import { PhotoInboxModule } from '../storage/photo-inbox.module.js';
import { PhotoWorkerModule } from '../photo-worker/photo-worker.module.js';
import { ProgressController } from './progress.controller.js';
import { ProgressService } from './progress.service.js';

@Module({
  imports: [ImageUploadModule, CarePlanModule, PhotoInboxModule, PhotoWorkerModule],
  controllers: [ProgressController],
  providers: [ProgressService],
  exports: [ProgressService],
})
export class ProgressModule {}
