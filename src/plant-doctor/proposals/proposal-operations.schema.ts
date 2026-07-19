import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { Task, ProgressHealth } from '@prisma/client';
import { plantProfileUpdateSchema, PROGRESS_TAG_KEYS } from '@retaxmaster/my-plants-species-schema';
import { MAX_SIZE_CM } from '../../progress/progress.dto.js';

/** Calendar date, per the project's date rules. NEVER an ISO instant. */
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD calendar date');

/**
 * The operation vocabulary is DERIVED, never hand-authored. Every literal below comes from the
 * canonical source that already owns it, so this schema cannot drift from the DB, from the existing
 * DTOs, or from the agent's own validator (fork-prevention rule):
 *   - tasks   → the Prisma `Task` enum (WATER, FERTILIZE, REPOT, ROTATE, CLEAN_LEAVES, MIST, PROGRESS)
 *   - health  → the Prisma `ProgressHealth` enum (SICK, POOR, GOOD, EXCELLENT)
 *   - tags    → PROGRESS_TAG_KEYS in @retaxmaster/my-plants-species-schema (a CLOSED vocabulary,
 *               NOT free strings — `parseProgressTags` already rejects unknown keys today)
 *   - profile → `plantProfileUpdateSchema` from the same shared package, composed rather than
 *               re-declared. Its enums are lower-kebab ('plastic', 'on-sill'); this file never
 *               retypes one.
 *   - bounds  → the existing progress DTO's own limits (observations ≤ 2000, sizeCm ≤ MAX_SIZE_CM)
 * Writing any of these out by hand is a defect: it is exactly how the API and the agent end up
 * validating two different vocabularies. The parity tests assert each derivation.
 */

/**
 * Frequency-bearing tasks only. PROGRESS is reserved (fixed weekly cadence) and is never proposable —
 * the same exclusion `SetFrequencyDto` enforces with @IsNotIn([Task.PROGRESS]) and that
 * `FREQUENCY_TASKS` encodes in frequency.write-core.ts. Derive it from the enum; do not retype it.
 */
const FREQUENCY_BEARING_TASKS = Object.values(Task).filter((t) => t !== Task.PROGRESS);
const task = z.enum(FREQUENCY_BEARING_TASKS as [Task, ...Task[]]);
const health = z.nativeEnum(ProgressHealth);
const progressTag = z.enum(PROGRESS_TAG_KEYS as unknown as [string, ...string[]]);

const profileUpdate = plantProfileUpdateSchema.extend({ type: z.literal('profile.update') }).strict();

const plantUpdate = z
  .object({
    type: z.literal('plant.update'),
    nickname: z.string().max(120).nullable().optional(),
    placeId: z.string().min(1).optional(),
  })
  .strict();

const progressCreate = z
  .object({
    type: z.literal('progress.create'),
    health,
    occurredOn: ymd.optional(),
    // Bounds mirror CreateProgressDto exactly: observations @MaxLength(2000), sizeCm @IsPositive +
    // @Max(MAX_SIZE_CM) (the MariaDB signed-INT ceiling). tags are the CLOSED catalog vocabulary.
    observations: z.string().max(2000).nullable().optional(),
    sizeCm: z.number().int().positive().max(MAX_SIZE_CM).nullable().optional(),
    tags: z.array(progressTag).max(PROGRESS_TAG_KEYS.length).optional(),
  })
  .strict();

const progressUpdate = z
  .object({
    type: z.literal('progress.update'),
    entryId: z.string().min(1),
    health: health.optional(),
    occurredOn: ymd.optional(),
    observations: z.string().max(2000).nullable().optional(),
    sizeCm: z.number().int().positive().max(MAX_SIZE_CM).nullable().optional(),
    tags: z.array(progressTag).max(PROGRESS_TAG_KEYS.length).optional(),
  })
  .strict();

const progressDelete = z.object({ type: z.literal('progress.delete'), entryId: z.string().min(1) }).strict();
const frequencySet = z
  .object({ type: z.literal('frequency.set'), task, intervalDays: z.number().int().min(1).max(3650) })
  .strict();
const frequencyClear = z.object({ type: z.literal('frequency.clear'), task }).strict();
const careDone = z.object({ type: z.literal('care.done'), task, occurredOn: ymd }).strict();

/**
 * Keys that name the TARGET of an operation rather than a value it writes. An operation consisting of
 * nothing but its type and its target changes nothing, and must not be proposable.
 */
const IDENTITY_KEYS = new Set(['type', 'entryId', 'task']);

/**
 * The three PATCH-shaped operations have every value field optional, so `{ type: 'plant.update' }`
 * parses structurally while writing nothing. That must be a 400 rather than an empty write, and it is
 * why the applier can assume a non-empty patch.
 *
 * The check lives HERE, in a `superRefine` over the parsed union, and NOT as a `.refine()` on the three
 * members — a refined member is a `ZodEffects`, and zod 3's `discriminatedUnion` accepts only
 * `ZodObject`s. Casting a refined member into the union (as an earlier draft did) type-checks and then
 * throws "Cannot read properties of undefined (reading 'type')" at construction time. Refining the
 * union instead keeps discrimination — and its precise per-type errors — intact.
 */
const REQUIRES_A_FIELD = new Set(['profile.update', 'plant.update', 'progress.update']);

export const operationSchema = z
  .discriminatedUnion('type', [
    profileUpdate,
    plantUpdate,
    progressCreate,
    progressUpdate,
    progressDelete,
    frequencySet,
    frequencyClear,
    careDone,
  ])
  .superRefine((op, ctx) => {
    if (!REQUIRES_A_FIELD.has(op.type)) return;
    const writes = Object.keys(op).filter((k) => !IDENTITY_KEYS.has(k));
    if (writes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${op.type} requires at least one field to change`,
      });
    }
  });

export type ProposalOperation = z.infer<typeof operationSchema>;

export const MAX_OPERATIONS = 10;
export const MAX_SUMMARY_CHARS = 500;
export const MAX_SERIALIZED_BYTES = 64 * 1024;

export const createProposalSchema = z
  .object({
    summary: z.string().min(1).max(MAX_SUMMARY_CHARS),
    operations: z.array(operationSchema).min(1).max(MAX_OPERATIONS),
  })
  .strict();
export type CreateProposalBody = z.infer<typeof createProposalSchema>;

/** Stable identity of what an operation writes to. Two operations sharing one is an overlap. */
function writeSet(op: ProposalOperation): string[] {
  switch (op.type) {
    case 'profile.update':
      return Object.keys(op)
        .filter((k) => k !== 'type')
        .map((k) => `profile:${k}`);
    case 'plant.update':
      return Object.keys(op)
        .filter((k) => k !== 'type')
        .map((k) => `plant:${k}`);
    case 'progress.create':
      return []; // a create has no pre-existing target, so it can never collide
    case 'progress.update':
    case 'progress.delete':
      return [`entry:${op.entryId}`];
    case 'frequency.set':
    case 'frequency.clear':
      return [`frequency:${op.task}`];
    case 'care.done':
      return [`care:${op.task}:${op.occurredOn}`];
  }
}

/** Spec 5.2: overlapping write-sets are a 400 at propose time, so `snapshot` stays well-defined. */
export function assertNoOverlappingWriteSets(operations: ProposalOperation[]): void {
  const seen = new Set<string>();
  for (const op of operations) {
    for (const key of writeSet(op)) {
      if (seen.has(key)) {
        throw new BadRequestException(
          `operations overlap on ${key}; express the intended end state with one operation per target`,
        );
      }
      seen.add(key);
    }
  }
}

export function assertSerializedBound(value: unknown, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value ?? null)) > MAX_SERIALIZED_BYTES) {
    throw new BadRequestException(`${label} exceeds ${MAX_SERIALIZED_BYTES} bytes`);
  }
}
