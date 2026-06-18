import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // The web app (a different localhost port) calls this API from the browser, so enable CORS,
  // restricted to the web origin (env-overridable). Note: v1 has no auth (single-user, local);
  // real authentication arrives with multi-user — see the roadmap.
  app.enableCors({ origin: [process.env.WEB_ORIGIN ?? 'http://localhost:8001'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(loadEnv().PORT);
}

void bootstrap();
