import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { FeedbackDto } from './feedback.controller.js';

async function errors(body: Record<string, unknown>) {
  return validate(plainToInstance(FeedbackDto, body));
}

describe('FeedbackDto reason allow-list (spec F.9 — the WATER union REPOT vocabulary)', () => {
  it('accepts every REPOT inspection reason', async () => {
    for (const reason of ['not-needed-yet', 'needed-cannot-now', 'could-not-check']) {
      expect(
        await errors({ task: 'REPOT', type: 'POSTPONED', occurredOn: '2026-07-09', reason }),
      ).toHaveLength(0);
    }
  });

  it('still accepts every WATER reason (the shipped vocabulary is not narrowed)', async () => {
    for (const reason of ['intuition', 'dry-soil', 'soil-still-moist', 'no-time', 'other']) {
      expect(
        await errors({ task: 'WATER', type: 'DONE', occurredOn: '2026-07-09', reason }),
      ).toHaveLength(0);
    }
  });

  it('rejects a slug in neither vocabulary', async () => {
    const e = await errors({ task: 'REPOT', type: 'POSTPONED', occurredOn: '2026-07-09', reason: 'banana' });
    expect(e.length).toBeGreaterThan(0);
  });

  it('the allow-list is COARSE by design: a cross-task reason passes the DTO (the service gates it)', async () => {
    // This is the documented contract, not an oversight — one @IsIn covers both reason spaces, and the
    // service ignores a foreign slug (the REPOT flow defaults it to could-not-check; the WATER window
    // classifier never admits it). Pinned so a future "tighten the DTO" change is a deliberate act.
    expect(
      await errors({ task: 'WATER', type: 'POSTPONED', occurredOn: '2026-07-09', reason: 'not-needed-yet' }),
    ).toHaveLength(0);
  });

  it('still refuses PROGRESS as a feedback task', async () => {
    const e = await errors({ task: 'PROGRESS', type: 'DONE', occurredOn: '2026-07-09' });
    expect(e.length).toBeGreaterThan(0);
  });
});
