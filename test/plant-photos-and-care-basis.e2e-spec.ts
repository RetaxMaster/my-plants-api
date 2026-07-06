import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ImageUploadService } from '../src/storage/image-upload.service.js';
import { WeatherService } from '../src/weather/weather.service.js';

// Photos gallery + care-basis assembly + engine-untouched invariant, over the REAL HTTP stack.
// ImageUploadService faked (progress photos need an uploader); WeatherService null (offline recompute).
describe('Plant photos gallery & care-basis (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  const username = `e2e-pcb-${randomUUID()}`;
  const password = 'e2e-secret';
  let ownerId: string;
  let userId: string;
  let plantId: string;
  let emptyPlantId: string;
  let olderEntryId: string;
  let newerEntryId: string;

  let uploadSeq = 0;
  const fakeImages = {
    upload: async ({ keyPrefix }: { buffer: Buffer; keyPrefix: string }) => {
      uploadSeq += 1;
      return { imageUrl: `https://cdn.test/${uploadSeq}.webp`, imageObjectKey: `${keyPrefix}/${uploadSeq}.webp` };
    },
    delete: async (_key: string | null | undefined) => {},
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ImageUploadService).useValue(fakeImages)
      .overrideProvider(WeatherService).useValue({ forCity: async () => null })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); // mirror main.ts
    await app.init();

    prisma = app.get(PrismaService);
    const owner = await prisma.owner.create({ data: { name: username } });
    ownerId = owner.id;
    const user = await prisma.user.create({
      data: { username, passwordHash: await bcrypt.hash(password, 10), role: 'USER', ownerId },
    });
    userId = user.id;

    const server = app.getHttpServer();
    token = (await request(server).post('/auth/login').send({ username, password }).expect(201)).body.token;
    const species = await request(server).get('/species').expect(200);
    const slug = species.body[0].slug as string;
    const city = await auth(request(server).post('/cities'))
      .send({ name: 'PCB City', latitude: 19.43, longitude: -99.13, timezone: 'America/Mexico_City', isPrimary: true })
      .expect(201);
    const place = await auth(request(server).post('/places'))
      .send({ cityId: city.body.id, name: 'PCB Room', indoor: true, lightType: 'BRIGHT_INDIRECT' })
      .expect(201);
    const plant = await auth(request(server).post('/plants'))
      .send({ placeId: place.body.id, speciesSlug: slug, acquiredOn: '2020-01-01' })
      .expect(201);
    plantId = plant.body.id;
    const empty = await auth(request(server).post('/plants'))
      .send({ placeId: place.body.id, speciesSlug: slug, acquiredOn: '2020-01-01' })
      .expect(201);
    emptyPlantId = empty.body.id;

    // Older entry WITH a size + a photo.
    const older = await auth(request(server).post(`/plants/${plantId}/progress`))
      .field('health', 'GOOD').field('sizeCm', '25').field('occurredOn', '2026-01-10')
      .attach('photos', Buffer.from('old-a'), 'old-a.jpg')
      .expect(201);
    olderEntryId = older.body.id;
    // Newer entry WITHOUT a size (note only) + a photo — proves heightCm ignores it (separate read).
    const newer = await auth(request(server).post(`/plants/${plantId}/progress`))
      .field('health', 'EXCELLENT').field('observations', 'New leaf unfurling').field('occurredOn', '2026-03-15')
      .attach('photos', Buffer.from('new-a'), 'new-a.jpg')
      .expect(201);
    newerEntryId = newer.body.id;
    // A DONE REPOT feedback event -> lastRepottedOn.
    await auth(request(server).post(`/plants/${plantId}/feedback`))
      .send({ task: 'REPOT', type: 'DONE', occurredOn: '2026-02-20' })
      .expect(201);
  });

  afterAll(async () => {
    if (prisma) {
      const plantIds = (await prisma.plant.findMany({ where: { ownerId }, select: { id: true } })).map((p) => p.id);
      if (plantIds.length) {
        const where = { plantId: { in: plantIds } };
        const entryIds = (await prisma.plantProgressEntry.findMany({ where, select: { id: true } })).map((e) => e.id);
        if (entryIds.length) await prisma.plantProgressPhoto.deleteMany({ where: { entryId: { in: entryIds } } });
        await prisma.plantProgressEntry.deleteMany({ where });
        await prisma.plantProfile.deleteMany({ where });
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

  it('GET /plants/:id/photos flattens all progress photos newest-first, each carrying its entryId', async () => {
    const res = await auth(request(server()).get(`/plants/${plantId}/photos`)).expect(200);
    expect(res.body).toHaveLength(2);
    // Newer entry (2026-03-15) precedes older (2026-01-10).
    expect(res.body[0].entryId).toBe(newerEntryId);
    expect(res.body[1].entryId).toBe(olderEntryId);
    expect(res.body[0].occurredOn).toBe('2026-03-15');
    expect(res.body[1].occurredOn).toBe('2026-01-10');
    expect(res.body[0].imageUrl).toMatch(/^https:\/\/cdn\.test\//);
    expect(typeof res.body[0].id).toBe('string');
    expect(res.body[0].sortOrder).toBe(0);
  });

  it('GET /plants/:id/photos is empty for a plant with no progress photos', async () => {
    const res = await auth(request(server()).get(`/plants/${emptyPlantId}/photos`)).expect(200);
    expect(res.body).toEqual([]);
  });

  it('GET /plants/:id detail carries profile, latestProgress, and derived (separate heightCm read)', async () => {
    const res = await auth(request(server()).get(`/plants/${plantId}`)).expect(200);
    // latestProgress = the newest entry outright (note-only, no size).
    expect(res.body.latestProgress.entryId).toBe(newerEntryId);
    expect(res.body.latestProgress.occurredOn).toBe('2026-03-15');
    expect(res.body.latestProgress.health).toBe('EXCELLENT');
    expect(res.body.latestProgress.observations).toBe('New leaf unfurling');
    // heightCm = the newest entry WITH a size (the older one), NOT the newest entry.
    expect(res.body.derived.heightCm).toBe(25);
    // lastRepottedOn = the DONE REPOT event date.
    expect(res.body.derived.lastRepottedOn).toBe('2026-02-20');
    // profile present (all-null until a PATCH), and the internal object key never leaks.
    expect(res.body.profile).toEqual({
      windowDistance: null, growLight: null, potType: null, potSizeCm: null, hasDrainage: null,
      soilMix: null, growthHabit: null, ageMonths: null, nearHeater: null,
    });
    expect(res.body).not.toHaveProperty('coverImageObjectKey');
  });

  it('GET /plants list carries coverImageUrl (banner field) without the object key', async () => {
    const res = await auth(request(server()).get('/plants')).expect(200);
    const mine = res.body.find((p: { id: string }) => p.id === plantId);
    expect(mine).toBeDefined();
    expect(mine).toHaveProperty('coverImageUrl'); // null here (no cover set in this spec)
    expect(mine).not.toHaveProperty('coverImageObjectKey');
  });

  it('engine untouched: /plants/:id/care is identical before and after a profile PATCH', async () => {
    const before = await auth(request(server()).get(`/plants/${plantId}/care`)).expect(200);
    await auth(request(server()).patch(`/plants/${plantId}/profile`))
      .send({ potType: 'terracotta', growLight: true, ageMonths: 24 })
      .expect(200);
    const after = await auth(request(server()).get(`/plants/${plantId}/care`)).expect(200);
    // The profile is capture+display only — it feeds NO scheduling/viability computation.
    expect(after.body).toEqual(before.body);
  });
});
