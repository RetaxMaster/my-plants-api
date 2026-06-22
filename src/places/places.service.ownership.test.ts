import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { NotFoundException } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { PlacesService } from './places.service.js';

// A filter-honoring in-memory Prisma fake: it actually applies the `where.ownerId` (and `id`)
// the service passes, so the test proves ownership is enforced by the FILTER the service builds —
// hermetic, no live DB (matches the repo's unit-test convention). ADMIN passes `ownerFilter()` = {},
// so no ownerId constraint is applied → it can reach any owner's row.
function makeFakePrisma(seed: { places: any[]; cities: any[] }) {
  const matches = (row: any, where: any = {}) =>
    Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);
  const created: any[] = [];
  return {
    created,
    place: {
      findMany: async ({ where }: any = {}) => seed.places.filter((p) => matches(p, where)),
      findFirst: async ({ where }: any = {}) => seed.places.find((p) => matches(p, where)) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `place-${created.length + 1}`, ...data };
        created.push(row);
        seed.places.push(row);
        return row;
      },
    },
    city: {
      findFirst: async ({ where }: any = {}) => seed.cities.find((c) => matches(c, where)) ?? null,
    },
  } as any;
}

const actor = (ownerId: string, role: 'USER' | 'ADMIN') => ({
  userId: 'u', username: 'n', ownerId, role, jti: 'j', exp: 9e9,
});

function setup() {
  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const seed = {
    places: [
      { id: 'p-own', ownerId: 'owner-1', cityId: 'c-own', name: 'Mine', indoor: true, lightType: 'BRIGHT_INDIRECT' },
      { id: 'p-other', ownerId: 'owner-2', cityId: 'c-other', name: 'Theirs', indoor: true, lightType: 'BRIGHT_INDIRECT' },
    ],
    cities: [
      { id: 'c-own', ownerId: 'owner-1' },
      { id: 'c-other', ownerId: 'owner-2' },
    ],
  };
  const prisma = makeFakePrisma(seed);
  const svc = new PlacesService(prisma, owner, { recomputePlace: async () => {} } as any);
  const run = <T>(a: any, fn: () => Promise<T>) => cls.run(async () => { cls.set('actor', a); return fn(); });
  return { svc, prisma, run };
}

describe('PlacesService ownership', () => {
  it('a USER cannot read another owner row (NotFound)', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'USER'), async () => {
      await expect(svc.get('p-other')).rejects.toBeInstanceOf(NotFoundException);
      const list = await svc.list();
      expect(list.map((p: any) => p.id)).toEqual(['p-own']);
    });
  });

  it('an ADMIN can read any owner row', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'ADMIN'), async () => {
      const place = await svc.get('p-other');
      expect(place.id).toBe('p-other');
      const list = await svc.list();
      expect(list.map((p: any) => p.id).sort()).toEqual(['p-other', 'p-own']);
    });
  });

  it('creation always stamps the acting actor ownerId, even for an ADMIN', async () => {
    const { svc, prisma, run } = setup();
    await run(actor('owner-1', 'ADMIN'), async () => {
      const created = await svc.create({ cityId: 'c-own', name: 'New', indoor: true, lightType: 'BRIGHT_INDIRECT' as any });
      expect(created.ownerId).toBe('owner-1');
    });
    expect(prisma.created[0].ownerId).toBe('owner-1');
  });

  it('creation rejects a parent city that belongs to another owner', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'USER'), async () => {
      await expect(
        svc.create({ cityId: 'c-other', name: 'X', indoor: true, lightType: 'BRIGHT_INDIRECT' as any }),
      ).rejects.toThrow();
    });
  });
});
