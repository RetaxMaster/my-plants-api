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

// Cover-photo + profile over the REAL HTTP stack (guard -> CLS actor -> ownership -> Prisma -> DB).
// ImageUploadService is faked (records upload/delete so we can assert orphan-safe replace ordering);
// WeatherService returns null so the startup recompute can't hang offline.
describe('Plant cover-photo & profile (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let otherToken: string;
  const username = `e2e-cp-${randomUUID()}`;
  const otherName = `e2e-cp-other-${randomUUID()}`;
  const password = 'e2e-secret';
  let ownerId: string;
  let otherOwnerId: string;
  let userId: string;
  let otherUserId: string;
  let plantId: string;

  const deleteCalls: string[] = [];
  let uploadSeq = 0;
  const fakeImages = {
    upload: async ({ keyPrefix }: { buffer: Buffer; keyPrefix: string }) => {
      uploadSeq += 1;
      return { imageUrl: `https://cdn.test/${uploadSeq}.webp`, imageObjectKey: `${keyPrefix}/${uploadSeq}.webp` };
    },
    delete: async (key: string | null | undefined) => { if (key) deleteCalls.push(key); },
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
    const other = await prisma.owner.create({ data: { name: otherName } });
    otherOwnerId = other.id;
    const otherUser = await prisma.user.create({
      data: { username: otherName, passwordHash: await bcrypt.hash(password, 10), role: 'USER', ownerId: otherOwnerId },
    });
    otherUserId = otherUser.id;

    const server = app.getHttpServer();
    token = (await request(server).post('/auth/login').send({ username, password }).expect(201)).body.token;
    otherToken = (await request(server).post('/auth/login').send({ username: otherName, password }).expect(201)).body.token;

    const species = await request(server).get('/species').expect(200);
    expect(species.body.length).toBeGreaterThan(0);
    const slug = species.body[0].slug as string;
    const city = await auth(request(server).post('/cities'))
      .send({ name: 'CP City', latitude: 19.43, longitude: -99.13, timezone: 'America/Mexico_City', isPrimary: true })
      .expect(201);
    const place = await auth(request(server).post('/places'))
      .send({ cityId: city.body.id, name: 'CP Room', indoor: true, lightType: 'BRIGHT_INDIRECT' })
      .expect(201);
    const plant = await auth(request(server).post('/plants'))
      .send({ placeId: place.body.id, speciesSlug: slug, acquiredOn: '2020-01-01' })
      .expect(201);
    plantId = plant.body.id;
  });

  afterAll(async () => {
    if (prisma) {
      for (const oid of [ownerId, otherOwnerId]) {
        const plantIds = (await prisma.plant.findMany({ where: { ownerId: oid }, select: { id: true } })).map((p) => p.id);
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
        await prisma.plant.deleteMany({ where: { ownerId: oid } });
        await prisma.place.deleteMany({ where: { ownerId: oid } });
        await prisma.city.deleteMany({ where: { ownerId: oid } });
      }
      await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
      await prisma.owner.deleteMany({ where: { id: { in: [ownerId, otherOwnerId] } } });
    }
    if (app) await app.close();
  });

  const auth = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
  const asOther = (req: request.Test) => req.set('Authorization', `Bearer ${otherToken}`);
  const server = () => app.getHttpServer();

  it('PUT cover-photo sets coverImageUrl, writes NO progress entry, and does not leak the object key', async () => {
    const before = await prisma.plantProgressEntry.count({ where: { plantId } });
    const res = await auth(request(server()).put(`/plants/${plantId}/cover-photo`))
      .attach('photo', Buffer.from('fake-cover'), 'cover.jpg')
      .expect(200);
    expect(res.body.coverImageUrl).toMatch(/^https:\/\/cdn\.test\//);
    expect(res.body).not.toHaveProperty('coverImageObjectKey');
    // Setting a cover never creates a bitacora entry.
    expect(await prisma.plantProgressEntry.count({ where: { plantId } })).toBe(before);
    // The object key was persisted internally under the plant's cover prefix.
    const row = await prisma.plant.findUnique({ where: { id: plantId }, select: { coverImageObjectKey: true } });
    expect(row?.coverImageObjectKey).toMatch(new RegExp(`^plants/${plantId}/cover/`));
  });

  it('a second PUT replaces the cover and best-effort deletes the previous object', async () => {
    const previous = (await prisma.plant.findUnique({ where: { id: plantId }, select: { coverImageObjectKey: true } }))!.coverImageObjectKey!;
    const before = deleteCalls.length;
    const res = await auth(request(server()).put(`/plants/${plantId}/cover-photo`))
      .attach('photo', Buffer.from('fake-cover-2'), 'cover2.jpg')
      .expect(200);
    expect(res.body.coverImageUrl).toMatch(/^https:\/\/cdn\.test\//);
    expect(deleteCalls.slice(before)).toContain(previous);
  });

  it('DELETE cover-photo clears the columns and deletes the object (idempotent second call)', async () => {
    const current = (await prisma.plant.findUnique({ where: { id: plantId }, select: { coverImageObjectKey: true } }))!.coverImageObjectKey!;
    const before = deleteCalls.length;
    const res = await auth(request(server()).delete(`/plants/${plantId}/cover-photo`)).expect(200);
    expect(res.body.coverImageUrl).toBeNull();
    expect(deleteCalls.slice(before)).toContain(current);
    // Idempotent: a second DELETE is a no-op (no throw, still null).
    const res2 = await auth(request(server()).delete(`/plants/${plantId}/cover-photo`)).expect(200);
    expect(res2.body.coverImageUrl).toBeNull();
  });

  it('cover-photo is owner-scoped: another owner cannot set it (404)', async () => {
    await asOther(request(server()).put(`/plants/${plantId}/cover-photo`))
      .attach('photo', Buffer.from('nope'), 'x.jpg')
      .expect(404);
  });

  it('GET profile before any write returns the all-null shape', async () => {
    const res = await auth(request(server()).get(`/plants/${plantId}/profile`)).expect(200);
    expect(res.body).toEqual({
      windowDistance: null, growLight: null, potType: null, potSizeCm: null, hasDrainage: null,
      soilMix: null, growthHabit: null, ageMonths: null, nearHeater: null,
    });
  });

  it('PATCH profile upserts a partial body and leaves other fields untouched', async () => {
    const res = await auth(request(server()).patch(`/plants/${plantId}/profile`))
      .send({ potType: 'terracotta', potSizeCm: 14, nearHeater: true })
      .expect(200);
    expect(res.body.potType).toBe('terracotta');
    expect(res.body.potSizeCm).toBe(14);
    expect(res.body.nearHeater).toBe(true);
    expect(res.body.soilMix).toBeNull();
  });

  it('PATCH profile with explicit null clears one field but preserves the rest', async () => {
    const res = await auth(request(server()).patch(`/plants/${plantId}/profile`))
      .send({ potType: null })
      .expect(200);
    expect(res.body.potType).toBeNull();
    expect(res.body.potSizeCm).toBe(14); // untouched by the clear
    expect(res.body.nearHeater).toBe(true);
  });

  it('PATCH profile rejects an out-of-vocabulary enum and a non-positive potSizeCm (400)', async () => {
    await auth(request(server()).patch(`/plants/${plantId}/profile`)).send({ potType: 'wood' }).expect(400);
    await auth(request(server()).patch(`/plants/${plantId}/profile`)).send({ potSizeCm: 0 }).expect(400);
  });

  it('profile is owner-scoped: another owner cannot read or write it (404)', async () => {
    await asOther(request(server()).get(`/plants/${plantId}/profile`)).expect(404);
    await asOther(request(server()).patch(`/plants/${plantId}/profile`)).send({ potType: 'plastic' }).expect(404);
  });
});
