import 'reflect-metadata';
import './config/load-env-file.js'; // load .env before anything reads process.env
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Auth is on: a global JWT guard (default-deny) protects every route except those marked
  // @Public(). In production the browser talks to the web app's BFF, not this API directly, so the
  // bearer token never reaches the browser. CORS (restricted to the web origin, env-overridable) is
  // kept as a defensive allowance — harmless under the BFF, useful for local direct calls.
  app.enableCors({ origin: [process.env.WEB_ORIGIN ?? 'http://localhost:8001'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const env = loadEnv();
  await app.listen(env.PORT, env.HOST);
}

void bootstrap();
