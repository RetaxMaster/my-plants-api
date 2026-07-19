import type { Prisma } from '@prisma/client';

/** Spec 5.5.1 size bounds. A payload above this is recorded as truncated rather than stored. */
export const MAX_AUDIT_PAYLOAD_BYTES = 16 * 1024;

export type OriginAuditRow = {
  plantId: string;
  ownerId: string;
  origin: 'OWNER' | 'DOCTOR';
  /** Historical identifier only — NO foreign key, NO cascade (spec 7.4). */
  proposalId: string | null;
  actorUserId: string | null;
  operationType: string;
  targetTable: string;
  targetId: string | null;
  payload: unknown;
};

/**
 * Appends one audit row. MUST be called with the SAME transaction client as the write it describes
 * (spec 7.4) so the fact and its record commit together — an audit that can commit without its write,
 * or vice versa, is worse than no audit, because it is trusted and wrong.
 */
export async function writeOriginAudit(tx: Prisma.TransactionClient, row: OriginAuditRow): Promise<void> {
  let payloadJson = JSON.stringify(row.payload ?? null);
  if (Buffer.byteLength(payloadJson) > MAX_AUDIT_PAYLOAD_BYTES) {
    payloadJson = JSON.stringify({ truncated: true });
  }
  await tx.plantWriteAudit.create({
    data: {
      plantId: row.plantId,
      ownerId: row.ownerId,
      origin: row.origin,
      proposalId: row.proposalId,
      actorUserId: row.actorUserId,
      operationType: row.operationType,
      targetTable: row.targetTable,
      targetId: row.targetId,
      payloadJson,
    },
  });
}
