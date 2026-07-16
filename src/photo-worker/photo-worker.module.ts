import { Module } from '@nestjs/common';
import { PhotoInboxModule } from '../storage/photo-inbox.module.js';
import { ImageUploadModule } from '../storage/image-upload.module.js';
import { PhotoWorkerService } from './photo-worker.service.js';

@Module({
  imports: [PhotoInboxModule, ImageUploadModule],
  providers: [PhotoWorkerService],
  exports: [PhotoWorkerService],
})
export class PhotoWorkerModule {}
