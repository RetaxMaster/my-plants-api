import { Module } from '@nestjs/common';
import { RolesGuard } from '../auth/roles.guard.js';
import { BlogPublicController } from './blog-public.controller.js';
import { BlogpostAdminController } from './blogpost-admin.controller.js';
import { BlogService } from './blog.service.js';

// RolesGuard is a provider here so @UseGuards(RolesGuard) resolves it via DI (it injects Reflector from
// core + OwnerService from the global OwnerModule). ImageUploadModule is added in Phase 4 for covers.
@Module({
  controllers: [BlogPublicController, BlogpostAdminController],
  providers: [BlogService, RolesGuard],
})
export class BlogModule {}
