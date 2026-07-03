import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { BadRequestException } from '@nestjs/common';
import { Task } from '@prisma/client';
import { FeedbackDto } from './feedback.controller.js';
import { FeedbackService } from './feedback.service.js';
import { OwnerService } from '../owner/owner.service.js';

describe('FeedbackDto — PROGRESS is rejected at validation', () => {
  it('accepts a WATER DONE', async () => {
    const dto = plainToInstance(FeedbackDto, { task: 'WATER', type: 'DONE', occurredOn: '2026-07-02' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a PROGRESS feedback event', async () => {
    const dto = plainToInstance(FeedbackDto, { task: 'PROGRESS', type: 'DONE', occurredOn: '2026-07-02' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('FeedbackService.record — PROGRESS guard (defense in depth)', () => {
  it('throws BadRequestException before any write when task is PROGRESS', async () => {
    const prisma = {} as any; // must never be touched
    const cls = new ClsService(new AsyncLocalStorage());
    const owner = new OwnerService(cls);
    const carePlan = { recomputePlant: async () => {} } as any;
    const svc = new FeedbackService(prisma, owner, carePlan);
    await cls.run(async () => {
      cls.set('actor', { userId: 'u', username: 'n', ownerId: 'o', role: 'USER', jti: 'j', exp: 9e9 });
      await expect(
        svc.record({ plantId: 'p1', task: Task.PROGRESS, type: 'DONE', occurredOn: new Date('2026-07-02') }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
