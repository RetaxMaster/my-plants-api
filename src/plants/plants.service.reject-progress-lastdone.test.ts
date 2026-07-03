import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { BadRequestException } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { PlantsService } from './plants.service.js';
import { CreatePlantDto } from './create-plant.dto.js';

describe('CreatePlantDto — PROGRESS is rejected in lastDone', () => {
  it('accepts a WATER lastDone entry', async () => {
    const dto = plainToInstance(CreatePlantDto, {
      placeId: 'pl', speciesSlug: 's', acquiredOn: '2026-01-01',
      lastDone: [{ task: 'WATER', doneOn: '2026-06-01' }],
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a PROGRESS lastDone entry', async () => {
    const dto = plainToInstance(CreatePlantDto, {
      placeId: 'pl', speciesSlug: 's', acquiredOn: '2026-01-01',
      lastDone: [{ task: 'PROGRESS', doneOn: '2026-06-01' }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('PlantsService.create — PROGRESS lastDone guard (defense in depth)', () => {
  it('throws BadRequestException and creates NO plant/CareEvent when a lastDone is PROGRESS', async () => {
    let created = false;
    const prisma = {
      place: { findFirst: async () => ({ id: 'pl', ownerId: 'owner-1' }) },
      species: { findUnique: async () => ({ slug: 's' }) },
      plant: { create: async () => { created = true; return { id: 'new' }; } },
    } as any;
    const cls = new ClsService(new AsyncLocalStorage());
    const owner = new OwnerService(cls);
    const svc = new PlantsService(prisma, owner, { recomputePlant: async () => {} } as any, {} as any);
    await cls.run(async () => {
      cls.set('actor', { userId: 'u', username: 'n', ownerId: 'owner-1', role: 'USER', jti: 'j', exp: 9e9 });
      await expect(
        svc.create({ placeId: 'pl', speciesSlug: 's', acquiredOn: '2026-01-01', lastDone: [{ task: 'PROGRESS' as any, doneOn: '2026-06-01' }] } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    expect(created).toBe(false);
  });
});
