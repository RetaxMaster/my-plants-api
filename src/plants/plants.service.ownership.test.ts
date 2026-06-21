import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { NotFoundException } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { PlantsService } from './plants.service.js';

// A complete VALID species record (re-validated by parseSpeciesRecord on the read path).
const record = {
  scientificName: 'Dracaena trifasciata',
  commonNames: ['Snake plant'],
  watering: { baseIntervalDays: 14, soilDrynessBeforeWatering: 'mostly-dry', droughtTolerance: 'high', temperatureSensitivity: 'low', lightSensitivity: 'low', reduceInDormancy: true },
  light: { minimum: 'low', ideal: 'bright-indirect', maximum: 'direct' },
  temperature: { survivalMinC: 5, idealMinC: 18, idealMaxC: 27, survivalMaxC: 35 },
  humidity: { minimumPct: 30, idealPct: 45 },
  fertilizing: { activeSeasons: ['spring', 'summer'], inSeasonFrequencyDays: 30, reduceInDormancy: true },
  repotting: { typicalIntervalMonths: 36, signs: ['Roots out of drainage holes'] },
  maintenance: { pruning: 'Remove damaged leaves.', rotationDays: 30, leafCleaningDays: 30, commonPests: ['mealybugs'] },
  nativeClimate: { description: 'West African dry tropics.', koppen: 'Aw', hardinessMinC: 7, hardinessMaxC: 40 },
  metadata: { confidence: 'high', sources: [{ title: 'RHS', url: 'https://www.rhs.org.uk/plants/dracaena', accessedAt: '2026-06-18' }] },
};

function makeFakePrisma(seed: { plants: any[]; places: any[]; species: any[] }) {
  const matches = (row: any, where: any = {}) =>
    Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);
  const created: any[] = [];
  return {
    created,
    plant: {
      findMany: async ({ where }: any = {}) => seed.plants.filter((p) => matches(p, where)),
      findFirst: async ({ where }: any = {}) => seed.plants.find((p) => matches(p, where)) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `plant-${created.length + 1}`, ...data };
        created.push(row);
        return row;
      },
    },
    place: { findFirst: async ({ where }: any = {}) => seed.places.find((p) => matches(p, where)) ?? null },
    species: { findUnique: async ({ where }: any = {}) => seed.species.find((s) => s.slug === where.slug) ?? null },
  } as any;
}

const actor = (ownerId: string, role: 'USER' | 'ADMIN') => ({ userId: 'u', username: 'n', ownerId, role, jti: 'j', exp: 9e9 });

const plantRow = (id: string, ownerId: string) => ({
  id, ownerId, placeId: 'pl', speciesSlug: 'dracaena-trifasciata', nickname: id,
  acquiredOn: new Date('2026-01-01'), species: { scientificName: 'Dracaena trifasciata', record },
});

function setup() {
  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const seed = {
    plants: [plantRow('pl-own', 'owner-1'), plantRow('pl-other', 'owner-2')],
    places: [{ id: 'place-own', ownerId: 'owner-1' }, { id: 'place-other', ownerId: 'owner-2' }],
    species: [{ slug: 'dracaena-trifasciata' }],
  };
  const prisma = makeFakePrisma(seed);
  const svc = new PlantsService(prisma, owner, {} as any, {} as any);
  const run = <T>(a: any, fn: () => Promise<T>) => cls.run(async () => { cls.set('actor', a); return fn(); });
  return { svc, prisma, run };
}

describe('PlantsService ownership', () => {
  it('a USER cannot read another owner plant (NotFound) and lists only their own', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'USER'), async () => {
      await expect(svc.get('pl-other')).rejects.toBeInstanceOf(NotFoundException);
      const list = await svc.list();
      expect(list.map((p: any) => p.id)).toEqual(['pl-own']);
    });
  });

  it('an ADMIN can read any owner plant', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'ADMIN'), async () => {
      expect((await svc.get('pl-other')).id).toBe('pl-other');
      expect((await svc.list()).map((p: any) => p.id).sort()).toEqual(['pl-other', 'pl-own']);
    });
  });

  it('creation stamps the acting actor ownerId and validates the place FK against it', async () => {
    const { svc, prisma, run } = setup();
    await run(actor('owner-1', 'ADMIN'), async () => {
      await svc.create({ placeId: 'place-own', speciesSlug: 'dracaena-trifasciata', acquiredOn: '2026-01-01' } as any);
    });
    expect(prisma.created[0].ownerId).toBe('owner-1');
  });

  it('creation rejects a place that belongs to another owner', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'USER'), async () => {
      await expect(
        svc.create({ placeId: 'place-other', speciesSlug: 'dracaena-trifasciata', acquiredOn: '2026-01-01' } as any),
      ).rejects.toThrow();
    });
  });
});
