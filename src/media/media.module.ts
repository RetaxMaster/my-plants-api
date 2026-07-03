import { Module } from '@nestjs/common';
import { ImageUploadModule } from '../storage/image-upload.module.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';

// imports ImageUploadModule for the shared R2 pipeline; RolesGuard is a provider so @UseGuards resolves
// it via DI (Reflector + the global OwnerService).
@Module({
  imports: [ImageUploadModule],
  controllers: [MediaController],
  providers: [MediaService, RolesGuard],
})
export class MediaModule {}
