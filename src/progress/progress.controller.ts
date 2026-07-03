import { Body, Controller, Get, Param, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { imageUploadMulterOptions } from '../storage/multipart.config.js';
import { CreateProgressDto } from './progress.dto.js';
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
}
