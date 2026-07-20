import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_BODY_LIMIT_BYTES } from '../knowledge-chat/engine/body-limit.js';

/**
 * THE ONE declaration of everything an app instance needs beyond its module graph.
 *
 * This exists because none of it is inherited from `main.ts`: a `Test.createTestingModule(...)` app
 * starts with no global pipes and Express's default 100 kb body limit, so every e2e boot used to
 * re-apply the ValidationPipe by hand under a `// mirror main.ts` comment — nine hand-kept copies of one
 * configuration, which is the fork the project's no-fork rule forbids.
 *
 * It matters more now than it did: the body limit below is what makes an attachment payload crossable at
 * all, and a limit re-declared inside a test file would only ever prove that the TEST configured itself
 * correctly. A test must exercise the production configuration, not a lookalike — so both callers go
 * through here and the two cannot disagree.
 */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // The body limit is DERIVED FROM the attachment caps (see body-limit.ts), never hardcoded: attachments
  // travel as base64 inside JSON, and Nest's default is Express's 100 kb — small enough that a single
  // 200 kb photo would be refused by our own API long before reaching the engine. Raising a cap in
  // ATTACHMENT_CAPS raises this automatically, and a drift test asserts it never exceeds the engine's own.
  const express = app as NestExpressApplication;
  express.useBodyParser('json', { limit: API_BODY_LIMIT_BYTES });
  express.useBodyParser('urlencoded', { limit: API_BODY_LIMIT_BYTES, extended: true });
}
