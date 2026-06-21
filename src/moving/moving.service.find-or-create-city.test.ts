import { describe, expect, it, vi } from 'vitest';
import { MovingService } from './moving.service.js';

function makeService(savedCities: Array<{ id: string; latitude: number; longitude: number }>) {
  const created: Array<Record<string, unknown>> = [];
  const moves: Array<Record<string, unknown>> = [];
  const prisma = {
    city: {
      findMany: vi.fn(async () => savedCities),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `city-${created.length + 1}`, ...data };
        created.push(row);
        return row;
      }),
    },
    scheduledMove: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `move-${moves.length + 1}`, ...data };
        moves.push(row);
        return row;
      }),
    },
  } as unknown as ConstructorParameters<typeof MovingService>[0];
  const owner = {
    currentOwnerId: () => 'owner-1',
    currentRole: () => 'USER',
    ownerFilter: () => ({ ownerId: 'owner-1' }),
  } as unknown as ConstructorParameters<typeof MovingService>[1];
  const weather = {} as ConstructorParameters<typeof MovingService>[2];
  const carePlan = {} as ConstructorParameters<typeof MovingService>[3];
  const svc = new MovingService(prisma, owner, weather, carePlan);
  return { svc, prisma, created, moves };
}

const sel = { name: 'Guadalajara, Jalisco, Mexico', latitude: 20.66682, longitude: -103.39182, timezone: 'America/Mexico_City' };

describe('MovingService.schedule find-or-create city', () => {
  it('reuses a saved city whose coordinates match when rounded to 4 decimals', async () => {
    const { svc, prisma, created } = makeService([
      { id: 'existing', latitude: 20.6668, longitude: -103.3918 },
    ]);
    const out = await svc.schedule(sel, '2026-07-01');
    expect((prisma as unknown as { city: { create: ReturnType<typeof vi.fn> } }).city.create).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect(typeof out.id).toBe('string');
  });

  it('creates a new city when no saved city matches', async () => {
    const { svc, created } = makeService([
      { id: 'other', latitude: 19.4326, longitude: -99.1332 },
    ]);
    await svc.schedule(sel, '2026-07-01');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      ownerId: 'owner-1',
      name: sel.name,
      latitude: sel.latitude,
      longitude: sel.longitude,
      timezone: sel.timezone,
    });
  });

  it('binds moveOn as a native Date (MariaDB date rule)', async () => {
    const { svc, moves } = makeService([{ id: 'existing', latitude: 20.6668, longitude: -103.3918 }]);
    await svc.schedule(sel, '2026-07-01');
    expect(moves[0].moveOn).toBeInstanceOf(Date);
  });
});
