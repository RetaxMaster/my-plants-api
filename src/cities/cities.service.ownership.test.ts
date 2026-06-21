import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { NotFoundException } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { CitiesService } from './cities.service.js';

// Filter-honoring in-memory Prisma fake (see places.service.ownership.test.ts for rationale).
function makeFakePrisma(cities: any[]) {
  const matches = (row: any, where: any = {}) =>
    Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);
  const tx = {
    city: {
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const c of cities) if (matches(c, where)) { Object.assign(c, data); count++; }
        return { count };
      },
      update: async ({ where, data }: any) => {
        const c = cities.find((x) => x.id === where.id);
        Object.assign(c, data);
        return c;
      },
      create: async ({ data }: any) => {
        const row = { id: `city-${cities.length + 1}`, ...data };
        cities.push(row);
        return row;
      },
    },
  };
  return {
    cities,
    city: {
      findMany: async ({ where }: any = {}) => cities.filter((c) => matches(c, where)),
      findFirst: async ({ where }: any = {}) => cities.find((c) => matches(c, where)) ?? null,
    },
    $transaction: async (fn: any) => fn(tx),
  } as any;
}

const actor = (ownerId: string, role: 'USER' | 'ADMIN') => ({
  userId: 'u', username: 'n', ownerId, role, jti: 'j', exp: 9e9,
});

function setup() {
  const cls = new ClsService(new AsyncLocalStorage());
  const owner = new OwnerService(cls);
  const cities = [
    { id: 'o1-a', ownerId: 'owner-1', isPrimary: true },
    { id: 'o1-b', ownerId: 'owner-1', isPrimary: false },
    { id: 'o2-a', ownerId: 'owner-2', isPrimary: true },
    { id: 'o2-b', ownerId: 'owner-2', isPrimary: false },
  ];
  const prisma = makeFakePrisma(cities);
  const svc = new CitiesService(prisma, owner, {} as any);
  const run = <T>(a: any, fn: () => Promise<T>) => cls.run(async () => { cls.set('actor', a); return fn(); });
  return { svc, prisma, cities, run };
}

describe('CitiesService ownership', () => {
  it('a USER cannot read another owner city (NotFound)', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'USER'), async () => {
      await expect(svc.get('o2-a')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('an ADMIN can read any owner city', async () => {
    const { svc, run } = setup();
    await run(actor('owner-1', 'ADMIN'), async () => {
      expect((await svc.get('o2-a')).id).toBe('o2-a');
    });
  });

  it('makePrimary as ADMIN on another owner city scopes the reset to THAT owner only', async () => {
    const { svc, cities, run } = setup();
    await run(actor('owner-1', 'ADMIN'), async () => {
      await svc.makePrimary('o2-b');
    });
    // owner-2's primary moved b←a; owner-1's primary is UNTOUCHED.
    expect(cities.find((c) => c.id === 'o2-b')!.isPrimary).toBe(true);
    expect(cities.find((c) => c.id === 'o2-a')!.isPrimary).toBe(false);
    expect(cities.find((c) => c.id === 'o1-a')!.isPrimary).toBe(true);
  });

  it('creation stamps the acting actor ownerId and scopes the isPrimary reset to that owner', async () => {
    const { svc, cities, run } = setup();
    await run(actor('owner-1', 'ADMIN'), async () => {
      const created = await svc.create({ name: 'New', latitude: 1, longitude: 2, timezone: 'UTC', isPrimary: true } as any);
      expect(created.ownerId).toBe('owner-1');
    });
    // owner-1's previous primary cleared; owner-2's primary untouched.
    expect(cities.find((c) => c.id === 'o1-a')!.isPrimary).toBe(false);
    expect(cities.find((c) => c.id === 'o2-a')!.isPrimary).toBe(true);
  });
});
