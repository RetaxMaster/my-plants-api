import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { imageUploadMulterOptions } from '../storage/multipart.config.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { OwnerService } from '../owner/owner.service.js';
import { BlogService } from './blog.service.js';
import { CreateBlogpostDto } from './dto/create-blogpost.dto.js';
import { UpdateBlogpostDto } from './dto/update-blogpost.dto.js';

// Writing-desk CRUD. Admin Scoped: the controller-scoped RolesGuard enforces the real ADMIN role
// (runs after the global JwtAuthGuard); the service applies NO owner filter, so all admins share.
@Controller('blogposts')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class BlogpostAdminController {
  constructor(
    private readonly blog: BlogService,
    private readonly owner: OwnerService,
  ) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('q') q?: string,
  ) {
    return this.blog.adminList({
      status: status !== undefined ? Number.parseInt(status, 10) : undefined,
      page: page !== undefined ? Number.parseInt(page, 10) : undefined,
      pageSize: pageSize !== undefined ? Number.parseInt(pageSize, 10) : undefined,
      q,
    });
  }

  @Post()
  create(@Body() dto: CreateBlogpostDto) {
    return this.blog.create(dto, this.owner.currentActor()?.userId ?? null);
  }

  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.blog.adminGet(slug);
  }

  @Patch(':slug')
  update(@Param('slug') slug: string, @Body() dto: UpdateBlogpostDto) {
    return this.blog.update(slug, dto);
  }

  @Delete(':slug')
  remove(@Param('slug') slug: string) {
    return this.blog.remove(slug);
  }

  @Post(':slug/cover')
  @UseInterceptors(FileInterceptor('cover', imageUploadMulterOptions))
  setCover(@Param('slug') slug: string, @UploadedFile() file: Express.Multer.File) {
    return this.blog.setCover(slug, file);
  }
}
