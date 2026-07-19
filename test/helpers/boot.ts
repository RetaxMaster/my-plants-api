import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
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

/**
 * ONE full-app boot for every Plant Doctor e2e file.
 *
 * This exists because two e2e specs need the identical hermetic stack, and copying the block would
 * fork it: the `WeatherService` stub (startup recompute otherwise hits live weather and hangs
 * offline), the fake image uploader, BOTH fake engines (no `claude`/`codex` is ever spawned), and the
 * manual `ValidationPipe` — which is NOT inherited from `main.ts` and whose absence turns validation
 * failures into silent 201s. A second copy drifting from this one would produce two different
 * "hermetic" stacks and e2e results that disagree for no visible reason.
 */
export type ExecuteCall = { kind: string; runId: string; env?: Record<string, string> };

const makeFakeEngine = (kind: string, executeCalls: ExecuteCall[]) => ({
  logDir: mkdtempSync(join(tmpdir(), `pd-e2e-${kind}-`)),
  execute: async (req: { runId: string; logPath: string; env?: Record<string, string> }) => {
    executeCalls.push({ kind, runId: req.runId, env: req.env });
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
  // NOT inherited from main.ts — must be re-applied by hand in every e2e boot.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
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
 * Every table holding a foreign key straight to `plants.id`, discovered from the SCHEMA ITSELF via
 * `information_schema.KEY_COLUMN_USAGE` rather than hand-maintained. A hand-written list is invisible to
 * a table nobody remembered to add — which is exactly how `due_caches` leaked four owners into the
 * shared local dev database: the post-commit care-plan recompute (and, locally, every `nest start
 * --watch` restart's startup recompute — see `src/startup/startup.service.ts`) writes a due-cache row for
 * every plant in the database, `due_caches` was missing from the old hand list, and the plant delete
 * below silently failed for every run whose plant was still present when a recompute fired. Re-derived
 * on every call so a NEW model with a plant FK is covered automatically, with no second list to update.
 */
async function tablesReferencingPlants(prisma: PrismaService): Promise<Array<{ table: string; column: string }>> {
  const rows = await prisma.$queryRaw<Array<{ TABLE_NAME: string; COLUMN_NAME: string }>>`
    SELECT DISTINCT TABLE_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'plants' AND REFERENCED_COLUMN_NAME = 'id'`;
  return rows.map((r) => ({ table: r.TABLE_NAME, column: r.COLUMN_NAME }));
}

/** Removes every row a booted suite created for these owners, in FK-safe order. */
export async function cleanupOwners(prisma: PrismaService, ownerIds: string[], userIds: string[]): Promise<void> {
  if (ownerIds.length === 0 && userIds.length === 0) return;

  await prisma.knowledgeChatSession.deleteMany({ where: { ownerId: { in: ownerIds } } }).catch(() => {});

  const fkTables = await tablesReferencingPlants(prisma);

  for (const oid of ownerIds) {
    // Every delete below still swallows its own error so one unexpected/renamed table cannot stop the
    // rest from being attempted — but swallowing ALL of them is exactly what made the original leak
    // invisible. The verification after this loop is what makes a real leftover LOUD instead of silent.
    for (const { table, column } of fkTables) {
      // `table`/`column` come from information_schema, never from caller input — only `oid` is a bound
      // parameter — so this is not a SQL-injection surface.
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM \`${table}\` WHERE \`${column}\` IN (SELECT id FROM plants WHERE owner_id = ?)`,
          oid,
        )
        .catch(() => {});
    }
    await prisma.plant.deleteMany({ where: { ownerId: oid } }).catch(() => {});
    await prisma.place.deleteMany({ where: { ownerId: oid } }).catch(() => {});
    await prisma.city.deleteMany({ where: { ownerId: oid } }).catch(() => {});
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await prisma.owner.deleteMany({ where: { id: { in: ownerIds } } }).catch(() => {});

  // A silent leak is the same family as a silent test failure (2026-07-18 ledger, "the suite leaked
  // fixtures"): verify the owners are ACTUALLY gone and fail loudly, naming the survivors, instead of
  // letting every `.catch(() => {})` above hide a real leftover row.
  const survivors = await prisma.owner.findMany({
    where: { id: { in: ownerIds } },
    select: { id: true, name: true },
  });
  if (survivors.length > 0) {
    throw new Error(
      `cleanupOwners left ${survivors.length} owner(s) behind: ` +
        `${survivors.map((s) => `${s.id} (${s.name})`).join(', ')}. A row referencing one of their ` +
        `plants/places/cities is still blocking the delete — check for a new foreign key to ` +
        `plants/places/cities/owners that this cleanup does not yet cover.`,
    );
  }
}
