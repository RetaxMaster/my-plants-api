import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { PlantsService } from './plants.service.js';

// A complete VALID species record (re-validated by parseSpeciesRecord on the read path).
const record = {
  scientificName: 'Dracaena trifasciata',
  commonNamesEn: ['Snake plant'],
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

const actor = (ownerId: string, role: 'USER' | 'ADMIN') => ({ userId: 'u', username: 'n', ownerId, role, jti: 'j', exp: 9e9 });
const placeRow = (id: string, ownerId: string) => ({
  id, ownerId, indoor: true, lightType: 'BRIGHT_INDIRECT', climateControlled: false,
  humidityCharacter: null, indoorTempMinC: null, indoorTempMaxC: null,
  city: { id: `city-${id}`, latitude: 10, longitude: 20, timezone: 'UTC' },
});
const plantRow = (id: string, ownerId: string, placeId: string) => ({
  id, ownerId, placeId, speciesSlug: 'dracaena-trifasciata', nickname: id,
  acquiredOn: new Date('2026-01-01'), species: { scientificName: 'Dracaena trifasciata', record },
});

function setup() {
  const matches = (row: any, where: any = {}) => Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);
  const seed = {
    plants: [plantRow('pl-own', 'owner-1', 'place-a'), plantRow('pl-other', 'owner-2', 'place-x')],
    places: [placeRow('place-a', 'owner-1'), placeRow('place-b', 'owner-1'), placeRow('place-x', 'owner-2'), placeRow('place-y', 'owner-2')],
  };
  const recomputed: string[] = [];
  const prisma = {
    plant: {
      findFirst: async ({ where }: any) => seed.plants.find((p) => matches(p, where)) ?? null,
      update: async ({ where, data }: any) => { const p = seed.plants.find((x) => x.id === where.id); Object.assign(p!, data); return p; },
    },
    place: { findFirst: async ({ where }: any) => seed.places.find((p) => matches(p, where)) ?? null },
    plantProfile: { findUnique: async () => null, upsert: async ({ create }: any) => ({ ...create }) },
    plantProgressEntry: { findFirst: async () => null },
    careEvent: { findFirst: async () => null },
    plantWriteAudit: { create: async () => ({}) },
    // The write cores run inside the caller's transaction; this fake runs the callback against the
    // same client, the convention progress.service.test.ts already uses.
    $transaction: async (fn: any) => fn(prisma),
  } as any;
  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const carePlan = { recomputePlant: async (id: string) => { recomputed.push(id); } } as any;
  const weather = { forCity: async () => ({ tempC: 20, humidityPct: 50, seasonalLowC: 10, seasonalHighC: 30 }) } as any;
  const svc = new PlantsService(prisma, owner, carePlan, weather, {} as any);
  const run = <T>(a: any, fn: () => Promise<T>) => cls.run(async () => { cls.set('actor', a); return fn(); });
  return { svc, run, recomputed, seed };
}

describe('PlantsService.update', () => {
  it('nickname-only change does not recompute and clears empty to null', async () => {
    const { svc, run, recomputed, seed } = setup();
    await run(actor('owner-1', 'USER'), async () => { await svc.update('pl-own', { nickname: '  ' }); });
    expect(seed.plants.find((p) => p.id === 'pl-own')!.nickname).toBeNull();
    expect(recomputed).toEqual([]);
  });

  it('place change persists and recomputes', async () => {
    const { svc, run, recomputed, seed } = setup();
    await run(actor('owner-1', 'USER'), async () => { await svc.update('pl-own', { placeId: 'place-b' }); });
    expect(seed.plants.find((p) => p.id === 'pl-own')!.placeId).toBe('place-b');
    expect(recomputed).toEqual(['pl-own']);
  });

  it('rejects moving to a place of another owner', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'USER'), async () => {
      await expect(svc.update('pl-own', { placeId: 'place-x' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('a USER cannot edit another owner plant', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'USER'), async () => {
      await expect(svc.update('pl-other', { nickname: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('an ADMIN acting-as another owner can edit that owner plant, validating the target place against the PLANT owner', async () => {
    const { svc, run, recomputed, seed } = setup();
    await run({ ...actor('owner-1', 'ADMIN'), actingAsOwnerId: 'owner-2' }, async () => {
      // pl-other belongs to owner-2; place-y also belongs to owner-2 → allowed.
      await svc.update('pl-other', { placeId: 'place-y' });
    });
    expect(seed.plants.find((p) => p.id === 'pl-other')!.placeId).toBe('place-y');
    expect(recomputed).toEqual(['pl-other']);
  });
});

describe('PlantsService.updateProfile', () => {
  it('recomputes the plant after a profile write (so new physical data moves the schedule)', async () => {
    const { svc, run, recomputed } = setup();
    await run(actor('owner-1', 'USER'), async () => {
      await svc.updateProfile('pl-own', { potType: 'terracotta', potSizeCm: 8 });
    });
    expect(recomputed).toEqual(['pl-own']);
  });

  it('a USER cannot edit another owner plant profile', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'USER'), async () => {
      await expect(svc.updateProfile('pl-other', { potType: 'plastic' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('PlantsService.viabilityPreview', () => {
  it('returns a viability result for a target place of the plant owner', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'USER'), async () => {
      const v = await svc.viabilityPreview('pl-own', 'place-b');
      expect(v).toHaveProperty('level');
      expect(Array.isArray(v.reasons)).toBe(true);
    });
  });

  it('rejects a place of another owner', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'USER'), async () => {
      await expect(svc.viabilityPreview('pl-own', 'place-x')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
