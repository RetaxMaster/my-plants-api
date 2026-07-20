import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { WeatherService } from '../../src/weather/weather.service.js';
import { ImageUploadService } from '../../src/storage/image-upload.service.js';
import { CodexRoleVerificationService } from '../../src/knowledge-chat/codex-role-verification.service.js';
import { KNOWLEDGE_ENGINE, DOCTOR_ENGINE } from '../../src/knowledge-chat/engine/engine-params.js';
import { configureApp } from '../../src/config/configure-app.js';

/**
 * ONE full-app boot for every Plant Doctor e2e file.
 *
 * This exists because two e2e specs need the identical hermetic stack, and copying the block would
 * fork it: the `WeatherService` stub (startup recompute otherwise hits live weather and hangs
 * offline), the fake image uploader, BOTH fake engines (no `claude`/`codex` is ever spawned), and the
 * shared `configureApp()` call — which is NOT inherited from `main.ts` and whose absence turns
 * validation failures into silent 201s. A second copy drifting from this one would produce two
 * different "hermetic" stacks and e2e results that disagree for no visible reason.
 */
export type ExecuteCall = {
  kind: string;
  runId: string;
  env?: Record<string, string>;
  // Attachments are deliberately NOT persisted on the run row (spec §4.1.1) — they pass THROUGH the
  // request in memory. Capturing them here is the only way an e2e can prove they actually crossed the
  // transport rather than being silently stripped by the global whitelist ValidationPipe.
  attachments?: Array<{ id: string; filename: string; mimeType: string; data: string }>;
};

const makeFakeEngine = (kind: string, executeCalls: ExecuteCall[]) => ({
  logDir: mkdtempSync(join(tmpdir(), `pd-e2e-${kind}-`)),
  execute: async (req: {
    runId: string;
    logPath: string;
    env?: Record<string, string>;
    attachments?: ExecuteCall['attachments'];
  }) => {
    executeCalls.push({ kind, runId: req.runId, env: req.env, attachments: req.attachments });
    await mkdir(dirname(req.logPath), { recursive: true });
    await writeFile(req.logPath, `{"type":"log.header","schemaVersion":"1.0.0","runId":"${req.runId}"}\n`, {
      flag: 'wx',
    });
  },
  providerStatus: async () => [
    { provider: 'claude', installed: true, authenticated: true, available: true },
    { provider: 'codex', installed: true, authenticated: true, available: true },
  ],
  commandCatalog: async () => ({ provider: 'claude', commands: [] }),
  loadHistory: async () => ({ provider: 'claude', providerSessionId: 'x', turns: [] }),
  onModuleInit: async () => {},
  onModuleDestroy: async () => {},
  get isRunning() {
    return false;
  },
});

export type BootedApp = {
  app: INestApplication;
  prisma: PrismaService;
  server: () => ReturnType<INestApplication['getHttpServer']>;
  executeCalls: ExecuteCall[];
  verification: CodexRoleVerificationService;
  /** Creates an owner + user and logs in, returning the ids and a live session token. */
  mkOwner: (name: string, role?: 'USER' | 'ADMIN') => Promise<{ ownerId: string; userId: string; token: string }>;
  /** Creates a city + place + plant for `token`'s owner and returns the plant id. */
  mkPlant: (token: string, label: string, speciesSlug: string) => Promise<string>;
  /** The first seeded species slug — every plant needs one. */
  firstSpeciesSlug: () => Promise<string>;
};

export async function bootTestApp(): Promise<BootedApp> {
  const executeCalls: ExecuteCall[] = [];
  const fakeImages = {
    upload: async () => ({ imageUrl: 'https://cdn.test/x.webp', imageObjectKey: 'k/x.webp' }),
    delete: async () => {},
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WeatherService)
    .useValue({ forLocation: async () => null, forCity: async () => null })
    .overrideProvider(ImageUploadService)
    .useValue(fakeImages)
    .overrideProvider(KNOWLEDGE_ENGINE)
    .useValue(makeFakeEngine('KNOWLEDGE', executeCalls))
    .overrideProvider(DOCTOR_ENGINE)
    .useValue(makeFakeEngine('DOCTOR', executeCalls))
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app); // the SAME configuration main.ts applies — never a hand-kept copy
  await app.init();

  const prisma = app.get(PrismaService);
  const verification = app.get(CodexRoleVerificationService);
  const server = () => app.getHttpServer();
  const password = 'e2e-secret';

  const mkOwner = async (name: string, role: 'USER' | 'ADMIN' = 'USER') => {
    const owner = await prisma.owner.create({ data: { name } });
    const user = await prisma.user.create({
      data: { username: name, passwordHash: await bcrypt.hash(password, 10), role, ownerId: owner.id },
    });
    const token = (await request(server()).post('/auth/login').send({ username: name, password }).expect(201)).body
      .token as string;
    return { ownerId: owner.id, userId: user.id, token };
  };

  const firstSpeciesSlug = async () =>
    (await request(server()).get('/species').expect(200)).body[0].slug as string;

  const mkPlant = async (token: string, label: string, speciesSlug: string) => {
    const as = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    const city = await as(request(server()).post('/cities'))
      .send({
        name: `${label} City`,
        latitude: 19.43,
        longitude: -99.13,
        timezone: 'America/Mexico_City',
        isPrimary: true,
      })
      .expect(201);
    const place = await as(request(server()).post('/places'))
      .send({ cityId: city.body.id, name: `${label} Room`, indoor: true, lightType: 'BRIGHT_INDIRECT' })
      .expect(201);
    const plant = await as(request(server()).post('/plants'))
      .send({ placeId: place.body.id, speciesSlug, acquiredOn: '2020-01-01' })
      .expect(201);
    return plant.body.id as string;
  };

  return { app, prisma, server, executeCalls, verification, mkOwner, mkPlant, firstSpeciesSlug };
}

/**
 * The FK-safe owner teardown now lives in `src/common/owner-teardown.ts`, shared with the QA fixture
 * reset (`npm run qa:reset`), which needs the identical operation. Re-exported here so every existing
 * e2e import keeps working unchanged — one implementation, two callers, no drift.
 */
export { cleanupOwners } from '../../src/common/owner-teardown.js';
