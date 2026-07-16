import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { imageUploadMulterOptions } from '../storage/multipart.config.js';
import { CreateProgressDto, UpdateProgressDto } from './progress.dto.js';
import { ProgressService } from './progress.service.js';

@Controller()
export class ProgressController {
  constructor(private readonly progress: ProgressService) {}

  // Static, non-plant path — declared first; distinct from any /plants route.
  @Get('progress/catalog')
  catalog() {
    return this.progress.catalog();
  }

  // Multipart: field name `photos`, max 8 files, the shared 10 MB memory-storage config from Spec 1.
  @Post('plants/:id/progress')
  @UseInterceptors(FilesInterceptor('photos', 8, imageUploadMulterOptions))
  create(
    @Param('id') id: string,
    @Body() dto: CreateProgressDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.progress.create(id, dto, files ?? []);
  }

  @Get('plants/:id/progress/:entryId')
  entry(@Param('id') id: string, @Param('entryId') entryId: string) {
    return this.progress.getEntry(id, entryId);
  }

  @Patch('plants/:id/progress/:entryId')
  @UseInterceptors(FilesInterceptor('photos', 8, imageUploadMulterOptions))
  update(
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Body() dto: UpdateProgressDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.progress.update(id, entryId, dto, files ?? []);
  }

  @Post('plants/:id/progress/:entryId/photos/:photoId/retry')
  @HttpCode(HttpStatus.OK) // returns the refreshed entry, not a created resource — 200, not Nest's default 201
  retryPhoto(@Param('id') id: string, @Param('entryId') entryId: string, @Param('photoId') photoId: string) {
    return this.progress.retryPhoto(id, entryId, photoId);
  }

  @Delete('plants/:id/progress/:entryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Param('entryId') entryId: string) {
    return this.progress.delete(id, entryId);
  }

  @Get('plants/:id/history')
  history(@Param('id') id: string) {
    return this.progress.history(id);
  }
}
