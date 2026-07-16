import { Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { PhotoInboxService } from './photo-inbox.service.js';

@Module({
  providers: [
    // Built via a factory so the constructor's test-seam `disk` param stays OUT of Nest DI; prod gets
    // just the Env and the real statfs-based free-space probe (mirrors ImageUploadModule's pattern).
    { provide: PhotoInboxService, useFactory: (env: Env) => new PhotoInboxService(env), inject: [ENV] },
  ],
  exports: [PhotoInboxService],
})
export class PhotoInboxModule {}
