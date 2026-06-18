import { Global, Module } from '@nestjs/common';
import { buildDatabaseUrl } from './database-url.js';
import { loadEnv, type Env } from './env.js';

export const ENV = Symbol('ENV');
export const DATABASE_URL = Symbol('DATABASE_URL');

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: (): Env => loadEnv() },
    { provide: DATABASE_URL, useFactory: (env: Env): string => buildDatabaseUrl(env), inject: [ENV] },
  ],
  exports: [ENV, DATABASE_URL],
})
export class ConfigModule {}
