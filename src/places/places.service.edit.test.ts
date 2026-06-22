import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { NotFoundException } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { PlacesService } from './places.service.js';

const actor = (ownerId: string, role: 'USER' | 'ADMIN') => ({ userId: 'u', username: 'n', ownerId, role, jti: 'j', exp: 9e9 });

function setup() {
  const matches = (row: any, where: any = {}) => Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);
  const seed = { places: [{ id: 'p1', ownerId: 'owner-1', name: 'Sala', climateControlled: false }, { id: 'p2', ownerId: 'owner-2', name: 'Otra', climateControlled: false }] };
  const recomputed: string[] = [];
  const prisma = {
    place: {
      findFirst: async ({ where }: any) => seed.places.find((p) => matches(p, where)) ?? null,
      update: async ({ where, data }: any) => { const p = seed.places.find((x) => x.id === where.id); Object.assign(p!, data); return p; },
    },
  } as any;
  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const carePlan = { recomputePlace: async (id: string) => { recomputed.push(id); } } as any;
  const svc = new PlacesService(prisma, owner, carePlan);
  const run = <T>(a: any, fn: () => Promise<T>) => cls.run(async () => { cls.set('actor', a); return fn(); });
  return { svc, run, recomputed, seed };
}

describe('PlacesService.update', () => {
  it('name-only change does not recompute', async () => {
    const { svc, run, recomputed, seed } = setup();
    await run(actor('owner-1', 'USER'), async () => { await svc.update('p1', { name: 'Estudio' }); });
    expect(seed.places.find((p) => p.id === 'p1')!.name).toBe('Estudio');
    expect(recomputed).toEqual([]);
  });

  it('climateControlled change recomputes the place', async () => {
    const { svc, run, recomputed, seed } = setup();
    await run(actor('owner-1', 'USER'), async () => { await svc.update('p1', { climateControlled: true }); });
    expect(seed.places.find((p) => p.id === 'p1')!.climateControlled).toBe(true);
    expect(recomputed).toEqual(['p1']);
  });

  it('setting climateControlled to its current value does not recompute', async () => {
    const { svc, run, recomputed } = setup();
    await run(actor('owner-1', 'USER'), async () => { await svc.update('p1', { climateControlled: false }); });
    expect(recomputed).toEqual([]);
  });

  it('a USER cannot edit another owner place', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'USER'), async () => {
      await expect(svc.update('p2', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
