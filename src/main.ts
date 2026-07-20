import 'reflect-metadata';
import './config/load-env-file.js'; // load .env before anything reads process.env
import sharp from 'sharp';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { configureApp } from './config/configure-app.js';

// Pin libvips at boot (spec §2 / §4.3): one decode thread and a 100 MB operation-cache cap so a future
// host with more cores or a bigger default cache cannot silently inflate the decode-RAM peak the 64 MP
// ceiling was measured against.
sharp.concurrency(1);
sharp.cache({ memory: 100 });

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Auth is on: a global JWT guard (default-deny) protects every route except those marked
  // @Public(). In production the browser talks to the web app's BFF, not this API directly, so the
  // bearer token never reaches the browser. CORS (restricted to the web origin, env-overridable) is
  // kept as a defensive allowance — harmless under the BFF, useful for local direct calls.
  app.enableCors({ origin: [process.env.WEB_ORIGIN ?? 'http://localhost:8001'] });
  // The global ValidationPipe AND the derived body-parser limit — declared once, in configure-app.ts, so
  // every e2e boot exercises the same configuration this process runs on instead of a hand-kept copy.
  configureApp(app);
  const env = loadEnv();
  await app.listen(env.PORT, env.HOST);
}

void bootstrap();
