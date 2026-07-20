import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ImageUploadService } from '../src/storage/image-upload.service.js';
import { WeatherService } from '../src/weather/weather.service.js';
import { configureApp } from '../src/config/configure-app.js';

// End-to-end for the Care-History feature over the REAL HTTP stack (guard → CLS actor → ownership →
// Prisma → DB), against a running MariaDB with migrations applied and >=1 species row.
//
// Two external boundaries are overridden so the run is deterministic and offline — exactly the seams
// the spec calls out as not-under-test here:
//   • ImageUploadService — a FAKE uploader (no real R2; live-bucket upload is the flagged gap that
//     needs the user's R2 credentials). It records upload/delete calls so we can assert ordering.
//   • WeatherService — returns null (no live Open-Meteo call), so the startup/whole-garden recompute
//     that runs on app.init() cannot hang on the network in a sandbox. The scheduling math still runs
//     fully; only the weather signal is absent (the engine already treats null weather as "no signal").
describe('Care History (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  const username = `e2e-ch-${randomUUID()}`;
  const password = 'e2e-secret';
  let ownerId: string;
  let userId: string;
  let plantId: string;

  // Async photo pipeline: the request STAGES photos (PENDING); the in-process worker later reads the inbox and
  // calls this fake uploader with an explicit per-claim `key` (no keyPrefix anymore). Capture `key` so tests
  // can assert which objects the worker actually wrote.
  const uploadCalls: { key?: string; keyPrefix?: string }[] = [];
  const deleteCalls: string[] = [];
  let uploadSeq = 0;
  const fakeImages = {
    upload: async ({ key, keyPrefix }: { buffer: Buffer; key?: string; keyPrefix?: string }) => {
      uploadSeq += 1;
      uploadCalls.push({ key, keyPrefix });
      const objectKey = key ?? `${keyPrefix}/${uploadSeq}.webp`;
      return { imageUrl: `https://cdn.test/${uploadSeq}.webp`, imageObjectKey: objectKey };
    },
    delete: async (key: string | null | undefined) => { if (key) deleteCalls.push(key); },
    confirmDelete: async (key: string) => { deleteCalls.push(key); },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ImageUploadService).useValue(fakeImages)
      .overrideProvider(WeatherService).useValue({ forCity: async () => null })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app); // the SAME configuration main.ts applies — never a hand-kept copy
    await app.init();

    prisma = app.get(PrismaService);
    const owner = await prisma.owner.create({ data: { name: username } });
    ownerId = owner.id;
    const user = await prisma.user.create({
      data: { username, passwordHash: await bcrypt.hash(password, 10), role: 'ADMIN', ownerId },
    });
    userId = user.id;

    const login = await request(app.getHttpServer()).post('/auth/login').send({ username, password }).expect(201);
    token = login.body.token as string;

    const server = app.getHttpServer();
    const species = await request(server).get('/species').expect(200);
    expect(species.body.length).toBeGreaterThan(0);
    const slug = species.body[0].slug as string;
    const city = await auth(request(server).post('/cities'))
      .send({ name: 'CH City', latitude: 19.43, longitude: -99.13, timezone: 'America/Mexico_City', isPrimary: true })
      .expect(201);
    const place = await auth(request(server).post('/places'))
      .send({ cityId: city.body.id, name: 'CH Room', indoor: true, lightType: 'BRIGHT_INDIRECT' })
      .expect(201);
    // Acquired long ago + a prior WATER done, so history has a real action note and Water is overdue.
    const plant = await auth(request(server).post('/plants'))
      .send({ placeId: place.body.id, speciesSlug: slug, acquiredOn: '2020-01-01', lastDone: [{ task: 'WATER', doneOn: '2026-06-20' }] })
      .expect(201);
    plantId = plant.body.id;
    await auth(request(server).post('/care-plan/recompute')).expect(201);
  });

  afterAll(async () => {
    if (prisma) {
      const plantIds = (await prisma.plant.findMany({ where: { ownerId }, select: { id: true } })).map((p) => p.id);
      if (plantIds.length) {
        const where = { plantId: { in: plantIds } };
        // Progress photos cascade-delete with their entry; delete entries + frequencies first (FK RESTRICT).
        const entryIds = (await prisma.plantProgressEntry.findMany({ where, select: { id: true } })).map((e) => e.id);
        if (entryIds.length) await prisma.plantProgressPhoto.deleteMany({ where: { entryId: { in: entryIds } } });
        await prisma.plantProgressEntry.deleteMany({ where });
        await prisma.plantTaskFrequency.deleteMany({ where });
        await prisma.dueCache.deleteMany({ where });
        await prisma.careEvent.deleteMany({ where });
        await prisma.plantTaskAdjustment.deleteMany({ where });
        await prisma.taskOverride.deleteMany({ where });
      }
      await prisma.plant.deleteMany({ where: { ownerId } });
      await prisma.place.deleteMany({ where: { ownerId } });
      await prisma.city.deleteMany({ where: { ownerId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.owner.deleteMany({ where: { id: ownerId } });
    }
    if (app) await app.close();
  });

  const auth = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
  const server = () => app.getHttpServer();

  it('GET /progress/catalog returns the single authoritative tag catalog', async () => {
    const res = await auth(request(server()).get('/progress/catalog')).expect(200);
    const keys = res.body.map((t: { key: string }) => t.key);
    expect(keys).toContain('PESTS');
    expect(keys).toContain('NEW_LEAF');
    expect(res.body.find((t: { key: string }) => t.key === 'PESTS').group).toBe('negative');
  });

  it('the weekly PROGRESS task appears in Today (recompute anchored it)', async () => {
    const today = await auth(request(server()).get('/care-plan/today')).expect(200);
    const mine = today.body.filter((t: { plantId: string; task: string }) => t.plantId === plantId);
    expect(mine.some((t: { task: string }) => t.task === 'PROGRESS')).toBe(true);
  });

  it('rejects a PROGRESS feedback event (400) — Progress is written only via the progress endpoint', async () => {
    await auth(request(server()).post(`/plants/${plantId}/feedback`))
      .send({ task: 'PROGRESS', type: 'DONE', occurredOn: '2026-07-02' })
      .expect(400);
  });

  it('POST /plants/:id/progress (multipart) stages photos (PENDING) + DONE PROGRESS event, drops Progress off Today; the worker then makes them READY', async () => {
    const res = await auth(request(server()).post(`/plants/${plantId}/progress`))
      .field('health', 'GOOD')
      .field('observations', 'Looking healthy')
      .field('sizeCm', '25')
      .field('tags', JSON.stringify(['NEW_LEAF', 'PESTS']))
      .attach('photos', Buffer.from('fake-a'), 'a.jpg')
      .attach('photos', Buffer.from('fake-b'), 'b.jpg')
      .expect(201);

    expect(res.body.health).toBe('GOOD');
    expect(res.body.sizeCm).toBe(25);
    expect(res.body.photos).toHaveLength(2);
    // Async pipeline (spec §5): a just-created photo is PENDING with no imageUrl yet — the worker uploads it
    // moments later. So the response shows processing, not a ready URL.
    expect(res.body.photos.every((p: { status: string }) => p.status === 'PENDING' || p.status === 'PROCESSING')).toBe(true);
    expect(res.body.photos[0].imageUrl).toBeNull();
    expect(res.body.processingCount).toBe(2);
    expect(res.body.tags.map((t: { key: string }) => t.key).sort()).toEqual(['NEW_LEAF', 'PESTS']);

    // Poll the entry until the in-process worker has processed both photos to READY (fake uploader, real inbox).
    const entryId = res.body.id as string;
    let detail: { photos: { status: string; imageUrl: string | null }[]; processingCount: number } | undefined;
    for (let i = 0; i < 100; i++) {
      detail = (await auth(request(server()).get(`/plants/${plantId}/progress/${entryId}`)).expect(200)).body;
      if (detail!.processingCount === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(detail!.processingCount).toBe(0);
    expect(detail!.photos).toHaveLength(2);
    expect(detail!.photos.every((p) => p.status === 'READY')).toBe(true);
    expect(detail!.photos[0].imageUrl).toMatch(/^https:\/\/cdn\.test\//);
    // The worker wrote exactly two objects under the plant's progress prefix (unique-per-claim keys); none deleted.
    expect(uploadCalls.filter((u) => u.key?.startsWith(`plants/${plantId}/progress/`)).length).toBe(2);
    expect(deleteCalls).toHaveLength(0);

    // A DONE PROGRESS CareEvent was recorded, and Progress re-anchored off Today (next Monday).
    const doneCount = await prisma.careEvent.count({ where: { plantId, task: 'PROGRESS', type: 'DONE' } });
    expect(doneCount).toBe(1);
    const today = await auth(request(server()).get('/care-plan/today')).expect(200);
    const mine = today.body.filter((t: { plantId: string; task: string }) => t.plantId === plantId);
    expect(mine.some((t: { task: string }) => t.task === 'PROGRESS')).toBe(false);
  });

  it('rejects an unknown tag with 400 and persists nothing (validation precedes staging)', async () => {
    // The async worker processes OTHER entries' staged photos in the background, so an upload-count proxy is
    // no longer valid. Assert the real invariant: a bad tag creates NO new progress entry for this plant.
    const before = await prisma.plantProgressEntry.count({ where: { plantId } });
    await auth(request(server()).post(`/plants/${plantId}/progress`))
      .field('health', 'GOOD')
      .field('tags', JSON.stringify(['NOT_A_REAL_TAG']))
      .attach('photos', Buffer.from('fake-c'), 'c.jpg')
      .expect(400);
    expect(await prisma.plantProgressEntry.count({ where: { plantId } })).toBe(before); // nothing persisted
  });

  it('GET /plants/:id/progress/:entryId returns the entry detail (resolved tags + ordered photos)', async () => {
    const entry = await prisma.plantProgressEntry.findFirst({ where: { plantId }, select: { id: true } });
    const res = await auth(request(server()).get(`/plants/${plantId}/progress/${entry!.id}`)).expect(200);
    expect(res.body.observations).toBe('Looking healthy');
    expect(res.body.photos).toHaveLength(2);
    expect(res.body.photos[0].sortOrder).toBe(0);
    expect(res.body.tags.map((t: { key: string }) => t.key).sort()).toEqual(['NEW_LEAF', 'PESTS']);
  });

  it('GET /plants/:id/history merges the progress entry + the prior WATER action, reverse-chronological', async () => {
    const res = await auth(request(server()).get(`/plants/${plantId}/history`)).expect(200);
    const kinds = res.body.map((i: { kind: string; task?: string; entryId?: string }) =>
      i.kind === 'progress' ? 'progress' : `action:${i.task}`);
    expect(kinds).toContain('progress');
    expect(kinds).toContain('action:WATER');
    // No PROGRESS-as-action, no POSTPONED/SYMPTOM.
    expect(res.body.every((i: { kind: string; task?: string }) => !(i.kind === 'action' && i.task === 'PROGRESS'))).toBe(true);
    // Reverse-chronological: the progress entry (today) precedes the WATER action (2026-06-20).
    const progressIdx = res.body.findIndex((i: { kind: string }) => i.kind === 'progress');
    const waterIdx = res.body.findIndex((i: { kind: string; task?: string }) => i.kind === 'action' && i.task === 'WATER');
    expect(progressIdx).toBeLessThan(waterIdx);
  });

  it('frequency seam: PUT changes the next WATER due, DELETE restores species-based scheduling', async () => {
    const server_ = server();
    const waterDue = async () => {
      const care = await auth(request(server_).get(`/plants/${plantId}/care`)).expect(200);
      return care.body.tasks.find((t: { task: string }) => t.task === 'WATER')?.nextDueOn as string;
    };
    const base = await waterDue();

    const set = await auth(request(server_).put(`/plants/${plantId}/frequency`))
      .send({ task: 'WATER', intervalDays: 90 }).expect(200);
    expect(set.body).toContainEqual({ task: 'WATER', intervalDays: 90 });
    const overridden = await waterDue();
    // A 90-day interval on a plant acquired 2020 pushes the next WATER due strictly later than the species base.
    expect(new Date(overridden).getTime()).toBeGreaterThan(new Date(base).getTime());

    const cleared = await auth(request(server_).delete(`/plants/${plantId}/frequency/WATER`)).expect(200);
    expect(cleared.body).toEqual([]);
    const restored = await waterDue();
    expect(restored).toBe(base);
  });

  it('frequency seam rejects PROGRESS (400) and a non-positive interval (400)', async () => {
    await auth(request(server()).put(`/plants/${plantId}/frequency`))
      .send({ task: 'PROGRESS', intervalDays: 7 }).expect(400);
    await auth(request(server()).put(`/plants/${plantId}/frequency`))
      .send({ task: 'WATER', intervalDays: 0 }).expect(400);
    await auth(request(server()).delete(`/plants/${plantId}/frequency/PROGRESS`)).expect(400);
  });
});
