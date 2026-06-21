import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Requires a running MariaDB with migrations applied and >=1 species row (inserted by the
// knowledge engine's db:insert).
//
// The login wall is ON (Phase 3): every protected route needs a bearer token. This suite seeds its
// own admin user + owner directly (real bcrypt hash, real DB row — the same thing the Phase 4
// user-create script does), then logs in through the REAL public POST /auth/login to obtain a real
// token, and sends it on every protected request. So it exercises the full guard → CLS actor →
// ownership path, not a bypass.
describe('MyPlants API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  const username = `e2e-${randomUUID()}`;
  const password = 'e2e-secret';
  let ownerId: string;
  let userId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); // mirror main.ts
    await app.init();

    prisma = app.get(PrismaService);
    const owner = await prisma.owner.create({ data: { name: username } });
    ownerId = owner.id;
    const user = await prisma.user.create({
      data: { username, passwordHash: await bcrypt.hash(password, 10), role: 'ADMIN', ownerId },
    });
    userId = user.id;

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username, password })
      .expect(201);
    token = login.body.token as string;
    expect(token).toBeTruthy();
  });

  afterAll(async () => {
    // Clean up the seeded fixtures (children first to respect FKs — plant relations have no cascade).
    const plantIds = (await prisma.plant.findMany({ where: { ownerId }, select: { id: true } })).map((p) => p.id);
    if (plantIds.length) {
      const where = { plantId: { in: plantIds } };
      await prisma.dueCache.deleteMany({ where });
      await prisma.careEvent.deleteMany({ where });
      await prisma.plantTaskAdjustment.deleteMany({ where });
      await prisma.taskOverride.deleteMany({ where });
    }
    await prisma.plant.deleteMany({ where: { ownerId } });
    await prisma.place.deleteMany({ where: { ownerId } });
    await prisma.scheduledMove.deleteMany({ where: { ownerId } });
    await prisma.city.deleteMany({ where: { ownerId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.owner.deleteMany({ where: { id: ownerId } });
    await app.close();
  });

  const auth = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);

  it('rejects a protected route without a token (login wall on)', async () => {
    await request(app.getHttpServer()).get('/plants').expect(401);
  });

  it('serves the public species catalog without a token', async () => {
    await request(app.getHttpServer()).get('/species').expect(200);
  });

  it('creates a city → place → plant and returns a computed care plan', async () => {
    const server = app.getHttpServer();
    const species = await request(server).get('/species').expect(200);
    expect(species.body.length).toBeGreaterThan(0);
    const slug = species.body[0].slug as string;

    const city = await auth(request(server).post('/cities'))
      .send({ name: 'Test City', latitude: 19.43, longitude: -99.13, timezone: 'America/Mexico_City', isPrimary: true })
      .expect(201);

    const place = await auth(request(server).post('/places'))
      .send({ cityId: city.body.id, name: 'Living room', indoor: true, lightType: 'BRIGHT_INDIRECT' })
      .expect(201);

    // Acquired long ago so every task is already overdue regardless of species intervals.
    const plant = await auth(request(server).post('/plants'))
      .send({ placeId: place.body.id, speciesSlug: slug, acquiredOn: '2020-01-01' })
      .expect(201);

    await auth(request(server).post('/care-plan/recompute')).expect(201);

    const today = await auth(request(server).get('/care-plan/today')).expect(200);
    expect(Array.isArray(today.body)).toBe(true);
    expect(today.body.some((t: { plantId: string }) => t.plantId === plant.body.id)).toBe(true);
  });
});
