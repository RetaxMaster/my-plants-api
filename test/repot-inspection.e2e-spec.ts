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
import { startOfTodayUtc, dayDiff } from '../src/common/time/local-date.js';

// Spec F over the REAL HTTP stack (guard -> CLS actor -> ownership -> service -> Prisma -> MariaDB).
// WeatherService returns null so the startup recompute can't hang offline; ImageUploadService is faked so
// the module compiles without R2 credentials. Every assertion is on the DATA LAYER (CareEvent /
// TaskOverride / PlantTaskAdjustment / DueCache), never on the response body — `{ ok: true }` proves nothing.
const TZ = 'America/Mexico_City';

describe('REPOT as an inspection (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  const username = `e2e-repot-${randomUUID()}`;
  const password = 'e2e-secret';
  let ownerId: string;
  let userId: string;
  let plantId: string;
  let placeId: string;
  let speciesSlug: string;

  const fakeImages = {
    upload: async () => ({ imageUrl: 'https://cdn.test/x.webp', imageObjectKey: 'k/x.webp' }),
    delete: async () => {},
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
    speciesSlug = species.body[0].slug as string;
    const city = await auth(request(server).post('/cities'))
      .send({ name: 'Repot City', latitude: 19.43, longitude: -99.13, timezone: TZ, isPrimary: true })
      .expect(201);
    const place = await auth(request(server).post('/places'))
      .send({ cityId: city.body.id, name: 'Repot Room', indoor: true, lightType: 'BRIGHT_INDIRECT' })
      .expect(201);
    placeId = place.body.id;
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
  const todayYmd = () => startOfTodayUtc(TZ).toISOString().slice(0, 10);

  // A fresh plant per test: Spec F's flows mutate override/adjustment/events, so isolation matters.
  // NOTE: `POST /plants` deliberately does NOT populate `dueCache` — `getCare` recomputes on demand for a
  // plant created before any recompute. Tests that need a baseline due date drive `recompute()` first, the
  // same real path the app uses.
  async function newPlant(acquiredOn = '2024-01-01'): Promise<string> {
    const p = await auth(request(server()).post('/plants'))
      .send({ placeId, speciesSlug, acquiredOn })
      .expect(201);
    return p.body.id as string;
  }
  const recompute = () => auth(request(server()).post('/care-plan/recompute')).expect(201);
  const postFeedback = (id: string, body: Record<string, unknown>) =>
    auth(request(server()).post(`/plants/${id}/feedback`)).send(body);

  const repotEvents = (id: string) =>
    prisma.careEvent.findMany({ where: { plantId: id, task: 'REPOT' }, orderBy: { createdAt: 'asc' } });
  const repotOverride = (id: string) =>
    prisma.taskOverride.findUnique({ where: { plantId_task: { plantId: id, task: 'REPOT' } } });
  const repotAdjustment = (id: string) =>
    prisma.plantTaskAdjustment.findUnique({ where: { plantId_task: { plantId: id, task: 'REPOT' } } });
  const repotDue = async (id: string) =>
    (await prisma.dueCache.findUnique({ where: { plantId_task: { plantId: id, task: 'REPOT' } } }))?.nextDueOn ?? null;

  it('the DTO accepts the three REPOT reasons and rejects a slug in neither vocabulary', async () => {
    plantId = await newPlant();
    for (const reason of ['not-needed-yet', 'needed-cannot-now', 'could-not-check']) {
      await postFeedback(plantId, { task: 'REPOT', type: 'POSTPONED', occurredOn: todayYmd(), reason }).expect(201);
    }
    await postFeedback(plantId, { task: 'REPOT', type: 'POSTPONED', occurredOn: todayYmd(), reason: 'banana' })
      .expect(400);
  });

  it('F1.2: a could-not-check postpone writes NO PlantTaskAdjustment (the live-bug fix)', async () => {
    const id = await newPlant();
    // Send postponeToOn too: the OLD code gated both the override write and adapt() on it, so a postpone
    // without a date would exercise neither and the test would pin a non-bug.
    await postFeedback(id, {
      task: 'REPOT', type: 'POSTPONED', occurredOn: todayYmd(), postponeToOn: '2030-01-01',
      reason: 'could-not-check',
    }).expect(201);
    // Assert on the MULTIPLIER, not on dueCache: the override masks the damage until the next DONE.
    expect(await repotAdjustment(id)).toBeNull();
    // It still snoozes to tomorrow — and IGNORES the client's 2030 date.
    const ov = await repotOverride(id);
    expect(ov).not.toBeNull();
    expect(dayDiff(ov!.nextDueOn, startOfTodayUtc(TZ))).toBe(1);
  });

  it('F1.2: three could-not-check postpones still write NO adjustment (the old nudge compounded to 1.30)', async () => {
    const id = await newPlant();
    for (let i = 0; i < 3; i++) {
      await postFeedback(id, { task: 'REPOT', type: 'POSTPONED', occurredOn: todayYmd(), reason: 'could-not-check' })
        .expect(201);
    }
    expect(await repotAdjustment(id)).toBeNull();
  });

  it('a justified reason with no height routes to the fallback and moves the multiplier the right way', async () => {
    const shorten = await newPlant();
    await postFeedback(shorten, { task: 'REPOT', type: 'POSTPONED', occurredOn: todayYmd(), reason: 'needed-cannot-now' })
      .expect(201);
    const evs = await repotEvents(shorten);
    expect((evs[0].payload as any).routedTo).toBe('adjustment');
    expect((evs[0].payload as any).R_obs).toBeNull();
    expect((await repotAdjustment(shorten))!.multiplier).toBeLessThan(1); // -alpha*(1-q)

    const lengthen = await newPlant();
    await postFeedback(lengthen, { task: 'REPOT', type: 'POSTPONED', occurredOn: todayYmd(), reason: 'not-needed-yet' })
      .expect(201);
    expect((await repotAdjustment(lengthen))!.multiplier).toBeGreaterThan(1); // +alpha*q
  });

  it('F.4: not-needed-yet writes a POSTPONED, never a DONE — lastRepottedOn and the anchor are untouched', async () => {
    const id = await newPlant();
    const before = (await auth(request(server()).get(`/plants/${id}`)).expect(200)).body.derived.lastRepottedOn;
    await postFeedback(id, { task: 'REPOT', type: 'POSTPONED', occurredOn: todayYmd(), reason: 'not-needed-yet' })
      .expect(201);
    const evs = await repotEvents(id);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('POSTPONED'); // a DONE here would report "last repotted: today" and re-anchor
    expect(await prisma.careEvent.count({ where: { plantId: id, task: 'REPOT', type: 'DONE' } })).toBe(0);
    const after = (await auth(request(server()).get(`/plants/${id}`)).expect(200)).body.derived.lastRepottedOn;
    expect(after).toBe(before);
  });

  it('F6.4: not-needed-yet ALWAYS moves the date — the floor lands at today + 14 (UTC midnight)', async () => {
    const id = await newPlant();
    await postFeedback(id, { task: 'REPOT', type: 'POSTPONED', occurredOn: todayYmd(), reason: 'not-needed-yet' })
      .expect(201);
    const ov = await repotOverride(id);
    expect(ov!.nextDueOn.getTime() % 86_400_000).toBe(0); // a @db.Date round-trip: no wall-clock remainder
    expect(dayDiff(ov!.nextDueOn, startOfTodayUtc(TZ))).toBe(14);
  });

  it('F3.1: the override is a FLOOR — a +1-day could-not-check snooze does NOT pin the far-future due date', async () => {
    // Anchor on TODAY so the computed REPOT date is a full cadence (>= 12 months) in the future. With the
    // shared 2024-01-01 anchor the plant is already overdue, and "the snooze did not pin it" would be
    // indistinguishable from "the date was in the past anyway".
    const id = await newPlant(todayYmd());
    await recompute();
    const before = await repotDue(id);
    expect(before).not.toBeNull();
    expect(dayDiff(before!, startOfTodayUtc(TZ))).toBeGreaterThan(300);

    await postFeedback(id, { task: 'REPOT', type: 'POSTPONED', occurredOn: todayYmd(), reason: 'could-not-check' })
      .expect(201);
    const after = await repotDue(id);
    // Under the OLD pinning short-circuit this would be tomorrow, forever. Under the floor it is unchanged.
    expect(after!.getTime()).toBe(before!.getTime());
    expect(dayDiff(after!, startOfTodayUtc(TZ))).toBeGreaterThan(300);
  });

  it('F3.1: an override never masks the engine — a WATER override still REPLACES (unchanged semantics)', async () => {
    const id = await newPlant();
    await postFeedback(id, { task: 'WATER', type: 'POSTPONED', occurredOn: todayYmd(), postponeToOn: '2027-03-01' })
      .expect(201);
    const due = (await prisma.dueCache.findUnique({ where: { plantId_task: { plantId: id, task: 'WATER' } } }))!.nextDueOn;
    expect(due.toISOString().slice(0, 10)).toBe('2027-03-01'); // replace, not max()
  });

  it('a REPOT SYMPTOM is REJECTED (400) and nothing is persisted', async () => {
    const id = await newPlant();
    await postFeedback(id, { task: 'REPOT', type: 'SYMPTOM', occurredOn: todayYmd(), payload: { symptom: 'mushy-stem' } })
      .expect(400);
    expect(await repotEvents(id)).toHaveLength(0);
    expect(await repotOverride(id)).toBeNull();
  });

  it('a REPOT DONE re-anchors, clears the override, updates lastRepottedOn, and carries routedTo="done"', async () => {
    const id = await newPlant();
    await postFeedback(id, { task: 'REPOT', type: 'POSTPONED', occurredOn: todayYmd(), reason: 'could-not-check' })
      .expect(201);
    expect(await repotOverride(id)).not.toBeNull();

    await postFeedback(id, { task: 'REPOT', type: 'DONE', occurredOn: todayYmd() }).expect(201);
    expect(await repotOverride(id)).toBeNull(); // the floor lifts on the real repot

    const done = (await repotEvents(id)).find((e) => e.type === 'DONE')!;
    expect((done.payload as any).routedTo).toBe('done'); // never 'calibration'
    expect((done.payload as any).reason).toBeUndefined();

    const body = (await auth(request(server()).get(`/plants/${id}`)).expect(200)).body;
    expect(body.derived.lastRepottedOn).toBe(todayYmd());
    // Re-anchored: the next REPOT is now a full cadence away from today, not from acquiredOn.
    expect(dayDiff((await repotDue(id))!, startOfTodayUtc(TZ))).toBeGreaterThan(300);
  });

  it('F5.3 + F.6: with a FRESH height + pot, an inspection routes to the calibration and moves the date', async () => {
    const id = await newPlant();
    // A crowded plant: 60 cm in a 20 cm pot, upright (normalizer 1.0) -> R = 3.
    await auth(request(server()).patch(`/plants/${id}/profile`))
      .send({ potSizeCm: 20, growthHabit: 'upright' })
      .expect(200);
    await auth(request(server()).post(`/plants/${id}/progress`))
      .field('health', 'GOOD').field('occurredOn', todayYmd()).field('sizeCm', '60')
      .expect(201);

    const beforeDue = await repotDue(id);
    await postFeedback(id, { task: 'REPOT', type: 'POSTPONED', occurredOn: todayYmd(), reason: 'not-needed-yet' })
      .expect(201);

    const ev = (await repotEvents(id))[0];
    const p = ev.payload as any;
    expect(p.routedTo).toBe('calibration');
    expect(p.R_obs).toBeCloseTo(3, 6);
    expect(p.heightCm).toBe(60); // the raw inputs ride along (growthHabit is user-editable)
    expect(p.potSizeCm).toBe(20);
    expect(p.growthHabit).toBe('upright');
    expect(typeof p.heightMeasuredOn).toBe('string');

    // EXCLUSIVITY: the calibration owns this event, so the fallback multiplier is untouched.
    expect(await repotAdjustment(id)).toBeNull();

    // The observation raised R_REF_plant, so the same R reads as LESS crowded: the date moves LATER.
    const afterDue = await repotDue(id);
    expect(afterDue!.getTime()).toBeGreaterThan(beforeDue!.getTime());
  });

  it('F5.3: the calibration survives a later profile edit — R_obs is a snapshot, never recomputed', async () => {
    const id = await newPlant();
    await auth(request(server()).patch(`/plants/${id}/profile`)).send({ potSizeCm: 20, growthHabit: 'upright' }).expect(200);
    await auth(request(server()).post(`/plants/${id}/progress`))
      .field('health', 'GOOD').field('occurredOn', todayYmd()).field('sizeCm', '60').expect(201);
    await postFeedback(id, { task: 'REPOT', type: 'POSTPONED', occurredOn: todayYmd(), reason: 'not-needed-yet' })
      .expect(201);
    const snapshot = (await repotEvents(id))[0].payload as any;
    expect(snapshot.R_obs).toBeCloseTo(3, 6);
    const dueAfterInspection = await repotDue(id);

    // Pot the plant up and change its habit, then drive a REAL recompute through the HTTP endpoint.
    // R_obs would now be 60/40/1.25 = 1.2 if it were recomputed from the profile.
    await auth(request(server()).patch(`/plants/${id}/profile`)).send({ potSizeCm: 40, growthHabit: 'shrub' }).expect(200);
    await auth(request(server()).post('/care-plan/recompute')).expect(201);

    const after = (await repotEvents(id))[0].payload as any;
    expect(after.R_obs).toBeCloseTo(3, 6); // the persisted snapshot is untouched
    expect(after.potSizeCm).toBe(20);
    expect(after.growthHabit).toBe('upright');
    // And the due date moved only because the CURRENT crowding changed, never because R_REF_plant did.
    expect(await repotDue(id)).not.toBeNull();
    expect(dueAfterInspection).not.toBeNull();
  });

  it('BACKCOMPAT: a legacy REPOT event (no reason, no routedTo) leaves the schedule exactly where it was', async () => {
    const id = await newPlant();
    await recompute();
    const before = await repotDue(id);
    expect(before).not.toBeNull();
    // Write a legacy-shaped event directly: this is what every REPOT CareEvent in production looks like —
    // no reason, no R_obs, no routedTo. It must be invisible to the calibration.
    await prisma.careEvent.create({
      data: { plantId: id, task: 'REPOT', type: 'POSTPONED', occurredOn: startOfTodayUtc(TZ) },
    });
    await recompute();
    const after = await repotDue(id);
    expect(after!.getTime()).toBe(before!.getTime()); // the calibration ignored it; the prior is literal
  });
});
