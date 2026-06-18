import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

// Requires a running MariaDB with migrations applied and >=1 species row (inserted by the
// knowledge engine's db:insert).
describe('MyPlants API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); // mirror main.ts
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a city → place → plant and returns a computed care plan', async () => {
    const server = app.getHttpServer();
    const species = await request(server).get('/species').expect(200);
    expect(species.body.length).toBeGreaterThan(0);
    const slug = species.body[0].slug as string;

    const city = await request(server)
      .post('/cities')
      .send({ name: 'Test City', latitude: 19.43, longitude: -99.13, timezone: 'America/Mexico_City', isPrimary: true })
      .expect(201);

    const place = await request(server)
      .post('/places')
      .send({ cityId: city.body.id, name: 'Living room', indoor: true, lightType: 'BRIGHT_INDIRECT' })
      .expect(201);

    // Acquired long ago so every task is already overdue regardless of species intervals.
    const plant = await request(server)
      .post('/plants')
      .send({ placeId: place.body.id, speciesSlug: slug, acquiredOn: '2020-01-01' })
      .expect(201);

    await request(server).post('/care-plan/recompute').expect(201);

    const today = await request(server).get('/care-plan/today').expect(200);
    expect(Array.isArray(today.body)).toBe(true);
    expect(today.body.some((t: { plantId: string }) => t.plantId === plant.body.id)).toBe(true);
  });
});
