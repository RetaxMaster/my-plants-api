import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // The web app (a different localhost port) calls this API from the browser, so enable CORS.
  // v1 is local-only and single-user; allow all origins. Tighten this when going multi-user.
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(loadEnv().PORT);
}

void bootstrap();
