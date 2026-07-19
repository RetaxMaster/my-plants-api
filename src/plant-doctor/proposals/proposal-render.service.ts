import { Injectable } from '@nestjs/common';
import type { DoctorWriteProposal } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ymdFromUtcDate } from '../../common/time/local-date.js';
import { ProposalSnapshotService } from './proposal-snapshot.service.js';
import type { ProposalOperation } from './proposal-operations.schema.js';

/**
 * ONE field-level change, fully rendered by the SERVER as display strings.
 *
 * This shape — not a raw payload object — is the contract, and the reason is spec §5.4: the target and
 * the before/after values must be "resolved to a human label the server owns". Handing the browser
 * `{ intervalDays: 7 }` would force it to know that `intervalDays` means "Water every N days", which is
 * a SECOND implementation of "what does this change mean", free to drift from the one that actually
 * applies the write. The owner must approve exactly what the server will do, described the way the
 * server describes it. This type is mirrored verbatim by `DoctorProposalChange` in the web's
 * `types/api.ts` — the web declares it, the server owns it, neither re-derives it.
 */
export type RenderedChange = {
  /** Server-owned human label for the field ("Pot type", "Every (days)"). */
  field: string;
  /**
   * ALWAYS the value to display as current: normally the immutable snapshot, and — when the record
   * drifted since the agent looked — the LIVE value (spec §5.5.3 forbids showing a stale snapshot as
   * current). `null` = the field currently has no value.
   */
  before: string | null;
  /** The proposed value, rendered. `null` = the operation CLEARS the field. */
  after: string | null;
  /**
   * Present ONLY when the live value drifted from the snapshot. Carries the third value — what the
   * agent originally saw — so all three of §5.5.3's values (snapshot / live / proposed) are on the
   * wire: `stale.atProposeTime` / `before` / `after` respectively.
   */
  stale?: { atProposeTime: string | null };
};

export type RenderedOperation = {
  type: ProposalOperation['type'];
  /** A human label the SERVER owns: the entry's date, the task name, the place's name. */
  targetLabel: string;
  changes: RenderedChange[];
  /** True for progress.delete — the entry and its photos are NOT recoverable (spec 7.2). */
  destructive: boolean;
};

export type ProposalView = {
  id: string;
  status: string;
  autoApproved: boolean;
  failureCode: string | null;
  failureReason: string | null;
  createdAt: Date;
  operations: RenderedOperation[];
  /** Agent-authored prose. A CAPTION ONLY — consent is on `operations` (spec 5.4). */
  summary: string;
};

/** Keys that identify the TARGET of an operation rather than a value it changes. */
const IDENTITY_KEYS = new Set(['entryId', 'task']);

/**
 * Server-owned field labels. English here, matching every other API-supplied catalog label in this
 * project (the known, documented i18n leak — see the workspace guide's note on `care.viability.reasons`).
 * Adding an operation field without adding its label is caught by the parity test, which walks the
 * operations union itself rather than a hand-written list.
 */
export const FIELD_LABELS: Record<string, string> = {
  // profile.update — the 9 fields
  windowDistance: 'Distance from the window',
  growLight: 'Grow light',
  potType: 'Pot type',
  potSizeCm: 'Pot size (cm)',
  hasDrainage: 'Drainage',
  soilMix: 'Soil mix',
  growthHabit: 'Growth habit',
  ageMonths: 'Age (months)',
  nearHeater: 'Near a heater',
  // plant.update
  nickname: 'Nickname',
  placeId: 'Place',
  // progress.*
  health: 'Health',
  occurredOn: 'Date',
  observations: 'Observations',
  sizeCm: 'Size (cm)',
  tags: 'Tags',
  // frequency.*
  intervalDays: 'Every (days)',
};

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

/** Render ONE value as the display string the owner consents to. */
function formatValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.length ? value.join(', ') : null; // tags: [] renders as "cleared"
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value instanceof Date) return ymdFromUtcDate(value);
  return String(value);
}

@Injectable()
export class ProposalRenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshots: ProposalSnapshotService,
  ) {}

  async render(proposal: DoctorWriteProposal): Promise<ProposalView> {
    const operations = JSON.parse(proposal.operations) as ProposalOperation[];
    const stored = JSON.parse(proposal.snapshot) as (Record<string, unknown> | null)[];
    // ⚠️ THE LIVE RE-READ IS FOR PENDING PROPOSALS ONLY.
    //
    // Drift detection answers ONE question: "has the record moved under a proposal the owner has not
    // decided on yet?" (spec §5.5.3). That question only exists while the proposal is PENDING. Once it is
    // terminal — APPROVED (including auto-approved under Skip Permissions), DECLINED, EXPIRED or FAILED —
    // this view is a STATEMENT OF RECORD: what was proposed, against the values it was proposed over.
    // Spec §5.4 pins `before` to the stored snapshot, and this response is both the agent's answer and the
    // audit's account of what changed.
    //
    // Re-reading live here on a terminal proposal reads back the proposal's OWN effect: after an apply the
    // live value IS the proposed value, so every change renders `before === after` (a no-op) carrying a
    // spurious `stale` marker that claims someone else moved the record. That is not a cosmetic defect —
    // it makes an applied write describe itself as "nothing happened, and by the way it drifted".
    // Measured on the Skip Permissions path, which is the only one that renders a terminal proposal to the
    // agent immediately after applying it.
    //
    // Using the stored snapshot as its own "live" value is what makes the comparison below yield "no
    // drift" for every field, rather than special-casing each `isStale` site.
    const live =
      proposal.status === 'PENDING'
        ? // Re-reading the CURRENT values through the same capture path the snapshot used is what makes
          // the stale comparison a like-for-like one: two implementations would differ in formatting
          // alone and mark every field as drifted.
          await this.snapshots.capture(proposal.plantId, proposal.ownerId, operations)
        : stored;

    const rendered: RenderedOperation[] = [];
    for (let i = 0; i < operations.length; i += 1) {
      const op = operations[i]!;
      const { type: _type, ...proposed } = op as Record<string, unknown> & { type: string };
      const snap = (stored[i] ?? null) as Record<string, unknown> | null;
      const now = (live[i] ?? null) as Record<string, unknown> | null;

      // One RenderedChange per field the operation touches.
      //
      // The key set is the UNION of the proposed keys and the SNAPSHOT keys — not the proposed keys
      // alone. This is what makes the two PURELY DESTRUCTIVE operations render at all: `frequency.clear`
      // and `progress.delete` propose no values, so a proposed-keys-only walk yields `changes: []` and
      // the banner shows an operation with nothing under it — asking the owner to consent to a blank.
      // Taking the union, their snapshot fields appear with `after: null`, which reads correctly as
      // "this value goes away". Identity fields (`entryId`, `task`) are the TARGET, not a change, and
      // are excluded — they are already in `targetLabel`.
      const keys = [...new Set([...Object.keys(proposed), ...Object.keys(snap ?? {})])].filter(
        (k) => !IDENTITY_KEYS.has(k),
      );

      const changes: RenderedChange[] = [];
      for (const key of keys) {
        const snapValue = snap ? snap[key] : undefined;
        const liveValue = now ? now[key] : undefined;
        // A key present in the snapshot but absent from `proposed` is being CLEARED by a destructive
        // operation → after is null. (For a PATCH-style update, an absent key means "unchanged" and is
        // never in the snapshot in the first place — the snapshot captures only the touched fields.)
        const afterValue = key in proposed ? proposed[key] : null;
        // Stale = the record drifted under the proposal for THIS field (spec 5.5.3).
        const isStale = JSON.stringify(snapValue ?? null) !== JSON.stringify(liveValue ?? null);
        changes.push({
          field: fieldLabel(key),
          // When stale, `before` is the LIVE value — never the stale snapshot rendered as current.
          before: await this.formatField(proposal.ownerId, key, isStale ? liveValue : snapValue),
          after: await this.formatField(proposal.ownerId, key, afterValue),
          ...(isStale
            ? { stale: { atProposeTime: await this.formatField(proposal.ownerId, key, snapValue) } }
            : {}),
        });
      }

      rendered.push({
        type: op.type,
        targetLabel: await this.label(proposal.plantId, proposal.ownerId, op),
        changes,
        destructive: op.type === 'progress.delete',
      });
    }

    return {
      id: proposal.id,
      status: proposal.status,
      autoApproved: proposal.autoApproved,
      failureCode: proposal.failureCode,
      failureReason: proposal.failureReason,
      createdAt: proposal.createdAt,
      operations: rendered,
      summary: proposal.summary,
    };
  }

  /**
   * Render ONE field value, resolving any value that is an ID into the name the owner recognises.
   *
   * `placeId` is the case that matters: showing `before: "clx7k2..." → after: "clx9m4..."` is not consent,
   * it is a hash the owner cannot evaluate — and "move the plant" is one of the more consequential
   * operations. Resolution is OWNER-SCOPED, so a foreign place can never render as a name; an
   * unresolvable id falls back to the id itself rather than to a blank the owner would read as "nowhere".
   */
  private async formatField(ownerId: string, key: string, value: unknown): Promise<string | null> {
    if (value === undefined || value === null) return null;
    if (key === 'placeId') {
      const place = await this.prisma.place.findFirst({ where: { id: String(value), ownerId } });
      return place?.name ?? String(value);
    }
    return formatValue(value);
  }

  /**
   * EVERY lookup here is scoped by the proposal's own plant/owner. This is not defensive style — an
   * unscoped `findFirst({ where: { id: op.placeId } })` would resolve and RENDER another owner's place
   * name into this owner's banner, leaking a foreign record through the consent surface. The proposal
   * row carries `plantId` and `ownerId` precisely so no query here has to guess the scope.
   */
  private async label(plantId: string, ownerId: string, op: ProposalOperation): Promise<string> {
    switch (op.type) {
      case 'frequency.set':
      case 'frequency.clear':
      case 'care.done':
        return op.task;
      case 'progress.update':
      case 'progress.delete': {
        const entry = await this.prisma.plantProgressEntry.findFirst({ where: { id: op.entryId, plantId } });
        return entry ? ymdFromUtcDate(entry.occurredOn) : op.entryId;
      }
      case 'plant.update': {
        if (op.placeId) {
          // Owner-scoped: a place belonging to anyone else must never resolve to a name.
          const place = await this.prisma.place.findFirst({ where: { id: op.placeId, ownerId } });
          return place?.name ?? op.placeId;
        }
        return 'nickname';
      }
      case 'profile.update':
        return 'profile';
      case 'progress.create':
        return 'new progress entry';
    }
  }
}
