import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ymdFromUtcDate } from '../../common/time/local-date.js';
import type { ProposalOperation } from './proposal-operations.schema.js';

/** One entry per operation, positionally aligned with `operations`. `null` = nothing existed before. */
export type ProposalSnapshot = (Record<string, unknown> | null)[];

/** Keys that name the TARGET of an operation rather than a value it writes. Never snapshotted. */
const IDENTITY_KEYS = new Set(['type', 'entryId', 'task']);

const toYmd = (d: Date | null | undefined): string | null => (d ? ymdFromUtcDate(d) : null);

@Injectable()
export class ProposalSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Captures the canonical before-values at PROPOSE time. Immutable thereafter (spec 5.2).
   *
   * The SAME method is reused at render time to read the LIVE values, which is what makes a stale
   * marker a comparison of like with like: if capture and "read current" were two implementations,
   * a formatting difference alone would show every field as drifted.
   *
   * Every read is scoped by BOTH plantId and ownerId. The snapshot feeds the owner's consent banner,
   * so an unscoped read is a path for a foreign record's value to be rendered to this owner.
   */
  async capture(plantId: string, ownerId: string, operations: ProposalOperation[]): Promise<ProposalSnapshot> {
    const out: ProposalSnapshot = [];
    for (const op of operations) out.push(await this.captureOne(plantId, ownerId, op));
    return out;
  }

  private async captureOne(
    plantId: string,
    ownerId: string,
    op: ProposalOperation,
  ): Promise<Record<string, unknown> | null> {
    switch (op.type) {
      case 'profile.update': {
        const row = (await this.prisma.plantProfile.findUnique({ where: { plantId } })) as Record<
          string,
          unknown
        > | null;
        return this.pick(row, this.touchedKeys(op));
      }
      case 'plant.update': {
        const row = (await this.prisma.plant.findFirst({ where: { id: plantId, ownerId } })) as Record<
          string,
          unknown
        > | null;
        return this.pick(row, this.touchedKeys(op));
      }
      case 'progress.create':
        return null;
      case 'progress.update': {
        const row = await this.prisma.plantProgressEntry.findFirst({ where: { id: op.entryId, plantId } });
        if (!row) return null;
        const src: Record<string, unknown> = { ...row, occurredOn: toYmd(row.occurredOn) };
        return this.pick(src, this.touchedKeys(op));
      }
      case 'progress.delete': {
        // A delete proposes no values, so "the fields it touches" is the whole entry — these are
        // exactly the values about to vanish, and the banner renders them with `after: null`.
        const row = await this.prisma.plantProgressEntry.findFirst({ where: { id: op.entryId, plantId } });
        if (!row) return null;
        return {
          health: row.health,
          occurredOn: toYmd(row.occurredOn),
          observations: row.observations,
          sizeCm: row.sizeCm,
          tags: row.tags,
        };
      }
      case 'frequency.set':
      case 'frequency.clear': {
        const row = await this.prisma.plantTaskFrequency.findFirst({ where: { plantId, task: op.task as never } });
        return { intervalDays: row?.intervalDays ?? null };
      }
      case 'care.done':
        // A care event is append-only: nothing is overwritten, so there is no before-value.
        return null;
    }
  }

  /** The value fields an operation writes — its own keys minus the ones that identify the target. */
  private touchedKeys(op: ProposalOperation): string[] {
    return Object.keys(op).filter((k) => !IDENTITY_KEYS.has(k));
  }

  private pick(row: Record<string, unknown> | null, keys: string[]): Record<string, unknown> | null {
    if (!row) return null;
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = row[k] ?? null;
    return out;
  }
}
