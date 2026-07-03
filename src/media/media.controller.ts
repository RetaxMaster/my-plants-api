import {
  Controller, Delete, Get, Param, Post, Query, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { imageUploadMulterOptions } from '../storage/multipart.config.js';
import { MediaService } from './media.service.js';

// Admin-Scoped image library. Every admin sees/deletes every asset (no owner filter).
@Controller('media')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post()
  @UseInterceptors(FileInterceptor('image', imageUploadMulterOptions))
  upload(@UploadedFile() file: Express.Multer.File) {
    return this.media.upload(file);
  }

  @Get()
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.media.list(
      page !== undefined ? Number.parseInt(page, 10) : undefined,
      pageSize !== undefined ? Number.parseInt(pageSize, 10) : undefined,
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.media.remove(id);
  }
}
