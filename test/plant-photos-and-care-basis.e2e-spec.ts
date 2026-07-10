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

  // CORRECTED 2026-07-09. This test used to assert `expect(after.body).toEqual(before.body)` under the claim
  // "the profile is capture+display only — it feeds NO scheduling/viability computation". That claim became
  // FALSE when the watering-precision engine wired `potType`, `potSizeCm`, `growLight`, `soilMix`,
  // `hasDrainage`, `nearHeater` and `growthHabit` into the watering center (docs/care-engine.md §7.10). The
  // test had been failing on `main` ever since; it was a stale claim, not a regression. It now asserts what
  // is actually true: the PHYSICAL profile moves the WATER date, and nothing else in the payload moves.
  it('a physical profile PATCH shortens the WATER date (terracotta breathes) and touches nothing else', async () => {
    const before = await auth(request(server()).get(`/plants/${plantId}/care`)).expect(200);
    await auth(request(server()).patch(`/plants/${plantId}/profile`))
      .send({ potType: 'terracotta', growLight: true, ageMonths: 24 })
      .expect(200);
    const after = await auth(request(server()).get(`/plants/${plantId}/care`)).expect(200);

    const water = (b: { tasks: { task: string; nextDueOn: string }[] }) =>
      b.tasks.find((t) => t.task === 'WATER')!.nextDueOn;
    // A porous pot (POT_MATERIAL 0.85) and a grow light both dry the soil faster → water SOONER.
    expect(new Date(water(after.body)).getTime()).toBeLessThan(new Date(water(before.body)).getTime());

    // Everything that the physical profile must NOT touch stays byte-identical.
    expect(after.body.viability).toEqual(before.body.viability);
    expect(after.body.crowding).toEqual(before.body.crowding); // no height, no potSizeCm → still no signal
    expect(after.body.soilDrynessBeforeWatering).toBe(before.body.soilDrynessBeforeWatering);
    const nonWater = (b: { tasks: { task: string }[] }) => b.tasks.filter((t) => t.task !== 'WATER');
    expect(nonWater(after.body)).toEqual(nonWater(before.body)); // FERTILIZE/REPOT/ROTATE/... unchanged
  });

  it('ageMonths alone feeds NO factor: the care payload is byte-identical (docs/care-engine.md §7.11)', async () => {
    const before = await auth(request(server()).get(`/plants/${plantId}/care`)).expect(200);
    await auth(request(server()).patch(`/plants/${plantId}/profile`)).send({ ageMonths: 99 }).expect(200);
    const after = await auth(request(server()).get(`/plants/${plantId}/care`)).expect(200);
    expect(after.body).toEqual(before.body);
  });
});
