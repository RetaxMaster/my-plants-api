import { describe, it, expect, vi } from 'vitest';
import { writeOriginAudit, MAX_AUDIT_PAYLOAD_BYTES } from './origin-audit.js';

const txWith = (create = vi.fn(async (_args: unknown) => ({}))) =>
  ({ plantWriteAudit: { create } }) as never;

describe('writeOriginAudit', () => {
  it('records an owner write with a null proposalId', async () => {
    const create = vi.fn(async (_args: unknown) => ({}));
    await writeOriginAudit(txWith(create), {
      plantId: 'p1',
      ownerId: 'o1',
      origin: 'OWNER',
      proposalId: null,
      actorUserId: 'u1',
      operationType: 'profile.update',
      targetTable: 'plant_profiles',
      targetId: 'p1',
      payload: { potType: 'PLASTIC' },
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ origin: 'OWNER', proposalId: null, operationType: 'profile.update' }),
    });
  });

  it('records a doctor write carrying the proposal id', async () => {
    const create = vi.fn(async (_args: unknown) => ({}));
    await writeOriginAudit(txWith(create), {
      plantId: 'p1',
      ownerId: 'o1',
      origin: 'DOCTOR',
      proposalId: 'prop-1',
      actorUserId: 'u1',
      operationType: 'progress.create',
      targetTable: 'plant_progress_entries',
      targetId: 'e1',
      payload: { health: 'GOOD' },
    });
    const data = (create.mock.calls[0][0] as { data: Record<string, string> }).data;
    expect(data.proposalId).toBe('prop-1');
    expect(JSON.parse(data.payloadJson)).toEqual({ health: 'GOOD' });
  });

  it('truncates an oversized payload rather than writing it', async () => {
    const create = vi.fn(async (_args: unknown) => ({}));
    await writeOriginAudit(txWith(create), {
      plantId: 'p1',
      ownerId: 'o1',
      origin: 'OWNER',
      proposalId: null,
      actorUserId: null,
      operationType: 'progress.update',
      targetTable: 'plant_progress_entries',
      targetId: 'e1',
      payload: { observations: 'x'.repeat(MAX_AUDIT_PAYLOAD_BYTES + 100) },
    });
    const written = (create.mock.calls[0][0] as { data: Record<string, string> }).data.payloadJson;
    expect(Buffer.byteLength(written)).toBeLessThanOrEqual(MAX_AUDIT_PAYLOAD_BYTES);
    expect(JSON.parse(written)).toEqual({ truncated: true });
  });
});
