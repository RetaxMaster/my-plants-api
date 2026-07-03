import { Module } from '@nestjs/common';
import { ImageUploadModule } from '../storage/image-upload.module.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { BlogPublicController } from './blog-public.controller.js';
import { BlogpostAdminController } from './blogpost-admin.controller.js';
import { BlogService } from './blog.service.js';

@Module({
  imports: [ImageUploadModule],
  controllers: [BlogPublicController, BlogpostAdminController],
  providers: [BlogService, RolesGuard],
})
export class BlogModule {}
