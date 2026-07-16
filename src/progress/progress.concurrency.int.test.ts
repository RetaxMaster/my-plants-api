// @vitest-environment node — real MariaDB, real interactive transactions. This is a genuine INTEGRATION
// test, not a fake-tx unit test: the ≤8-photos invariant + non-colliding sortOrder is a database
// SERIALIZATION property (two concurrent PATCHes racing on the same entry row's `SELECT ... FOR UPDATE`),
// which a fake `$transaction` cannot prove — asserting "the SQL text contains FOR UPDATE" verifies nothing
// about actual concurrent behaviour (progress-crud plan, Task 2 Step 1b / SHOULD-FIX 2).
//
// This file does NOT boot Nest (the unit vitest.config.ts has no swc plugin, so decorator metadata is
// dropped and DI breaks — only vitest.e2e.config.ts has swc, and that only covers test/**/*.e2e-spec.ts).
// Instead every collaborator is constructed manually, mirroring migration-0020-backfill.int.test.ts's
// "raw PrismaService, no Nest" pattern.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import '../config/load-env-file.js'; // load the app `.env` (DB_*) into process.env
import { loadDbEnv } from '../config/env.js';
import { buildDatabaseUrl } from '../config/database-url.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { ProgressService } from './progress.service.js';

const prisma = new PrismaService(buildDatabaseUrl(loadDbEnv()));
const cls = new ClsService(new AsyncLocalStorage());
const owner = new OwnerService(cls);

// Fakes for the non-DB collaborators (images/carePlan/inbox/worker) — the concurrency property under
// test lives entirely in the entry-row lock, so these stay inert/deterministic.
const images = { delete: async () => {}, confirmDelete: async () => {} } as any;
const carePlan = { recomputePlant: async () => {} } as any;
let stageSeq = 0;
const inbox = {
  stage: async (files: { buffer: Buffer; originalName: string }[]) =>
    files.map((f) => ({ inboxPath: `/tmp/progress-concurrency-int/${randomUUID()}-${(stageSeq += 1)}.bin`, originalName: f.originalName, sizeBytes: f.buffer.length })),
  deleteMany: async () => {},
  exists: async () => true,
} as any;
const worker = { enqueueTick() {} } as any;

const svc = new ProgressService(prisma, owner, images, carePlan, inbox, worker);
const runAs = <T>(ownerId: string, fn: () => Promise<T>) =>
  cls.run(async () => { cls.set('actor', { userId: 'u', username: 'n', ownerId, role: 'USER', jti: 'j', exp: 9e9 }); return fn(); });

const file = (name: string) => ({ buffer: Buffer.from(name), originalname: name }) as Express.Multer.File;

let ownerId: string;
let userId: string;
let cityId: string;
let placeId: string;
let plantId: string;
let entryId: string;

beforeAll(async () => {
  await prisma.onModuleInit();

  const species = await prisma.species.findFirst({ select: { slug: true } });
  if (!species) throw new Error('no seeded species found — cannot run the concurrency int test');

  const ownerRow = await prisma.owner.create({ data: { name: `concurrency-int-${randomUUID()}` } });
  ownerId = ownerRow.id;
  const userRow = await prisma.user.create({
    data: { username: `concurrency-int-${randomUUID()}`, passwordHash: 'x', role: 'USER', ownerId },
  });
  userId = userRow.id;
  const city = await prisma.city.create({
    data: { ownerId, name: 'Concurrency City', latitude: 19.43, longitude: -99.13, timezone: 'America/Mexico_City', isPrimary: true },
  });
  cityId = city.id;
  const place = await prisma.place.create({
    data: { ownerId, cityId, name: 'Concurrency Room', indoor: true, lightType: 'BRIGHT_INDIRECT' },
  });
  placeId = place.id;
  const plant = await prisma.plant.create({
    data: { ownerId, placeId, speciesSlug: species.slug, acquiredOn: new Date(Date.UTC(2020, 0, 1)) },
  });
  plantId = plant.id;

  // 7 READY photos — one PATCH can add up to 1 more (8 total), a second concurrent PATCH adding 1 more
  // would push it to 9 > 8, so exactly one of the two concurrent requests must be rejected.
  const entry = await prisma.plantProgressEntry.create({
    data: {
      plantId,
      occurredOn: new Date(Date.UTC(2026, 6, 1)),
      health: 'GOOD',
      photos: {
        create: Array.from({ length: 7 }, (_, i) => ({
          status: 'READY' as const,
          imageUrl: `https://cdn.test/concurrency-${i}.webp`,
          imageObjectKey: `concurrency/${i}.webp`,
          sortOrder: i,
        })),
      },
    },
    select: { id: true },
  });
  entryId = entry.id;
}, 30_000);

afterAll(async () => {
  // Clean up in FK order: photos cascade with the entry; then entry, plant, place, city, user, owner.
  await prisma.plantProgressEntry.deleteMany({ where: { plantId } }).catch(() => {});
  await prisma.plant.deleteMany({ where: { id: plantId } }).catch(() => {});
  await prisma.place.deleteMany({ where: { id: placeId } }).catch(() => {});
  await prisma.city.deleteMany({ where: { id: cityId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
  await prisma.owner.deleteMany({ where: { id: ownerId } }).catch(() => {});
  await prisma.onModuleDestroy();
}, 30_000);

it('two concurrent PATCHes adding a photo cannot exceed 8, and assign distinct sortOrders', async () => {
  const runOne = () => runAs(ownerId, () => svc.update(plantId, entryId, {} as any, [file(`concurrent-${randomUUID()}`)]));

  const [a, b] = await Promise.allSettled([runOne(), runOne()]);

  const codeOf = (r: PromiseSettledResult<unknown>) =>
    r.status === 'fulfilled' ? 'ok' : ((r.reason as any)?.response?.code ?? (r.reason as any)?.code);
  const outcomes = [a, b].map(codeOf);

  expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1); // exactly one succeeded
  expect(outcomes.filter((o) => o === 'too_many_photos')).toHaveLength(1); // the other was rejected under the lock

  const photos = await prisma.plantProgressPhoto.findMany({ where: { entryId } });
  expect(photos.length).toBeLessThanOrEqual(8); // invariant held
  const sorts = photos.map((p) => p.sortOrder);
  expect(new Set(sorts).size).toBe(sorts.length); // no sortOrder collision
}, 30_000);
