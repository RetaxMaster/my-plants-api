import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { ImageUploadService } from './image-upload.service.js';
import { ImageUploadExceptionFilter } from './image-upload.errors.js';

@Module({
  providers: [
    // Built via a factory so the constructor's test-seam `deps` param stays OUT of Nest DI; prod gets
    // just the Env and lazily builds the S3 client from R2 config on first upload.
    { provide: ImageUploadService, useFactory: (env: Env) => new ImageUploadService(env), inject: [ENV] },
    // Global filter registered as APP_FILTER (same pattern as AuthModule's APP_GUARD), so every
    // consumer inherits the typed-error→HTTP mapping. @Catch is narrowed to ImageUploadError, so it
    // touches nothing else in the app.
    { provide: APP_FILTER, useClass: ImageUploadExceptionFilter },
  ],
  exports: [ImageUploadService],
})
export class ImageUploadModule {}
