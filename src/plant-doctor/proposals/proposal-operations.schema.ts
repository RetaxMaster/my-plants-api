import { BadRequestException } from '@nestjs/common';
import {
  operationSchema,
  createProposalSchema,
  type ProposalOperation,
  type CreateProposalBody,
  MAX_OPERATIONS,
  MAX_SUMMARY_CHARS,
  MAX_SERIALIZED_BYTES,
  findOverlappingWriteSet,
  serializedBytes,
} from '@retaxmaster/my-plants-species-schema';

/**
 * The operation vocabulary is DERIVED, never hand-authored, and now lives in the shared package
 * (`@retaxmaster/my-plants-species-schema`'s `operationSchema` / `createProposalSchema`), which itself
 * derives every literal from the canonical source that owns it (the Prisma `Task`/`ProgressHealth`
 * enums, `PROGRESS_TAG_KEYS`, `plantProfileUpdateSchema`, and the progress DTO's own bounds). This file
 * only re-exports that union and keeps the two NestJS-throwing wrappers, which the shared package
 * cannot own because it must stay framework-agnostic (pure Zod, no Nest dependency). The parity test
 * (`proposal-operations.parity.test.ts`) asserts the shared vocab still matches Prisma/the DTO.
 */
export { operationSchema, createProposalSchema, MAX_OPERATIONS, MAX_SUMMARY_CHARS, MAX_SERIALIZED_BYTES };
export type { ProposalOperation, CreateProposalBody };

/** Spec 5.2: overlapping write-sets are a 400 at propose time, so `snapshot` stays well-defined. */
export function assertNoOverlappingWriteSets(operations: ProposalOperation[]): void {
  const overlap = findOverlappingWriteSet(operations);
  if (overlap !== null) {
    throw new BadRequestException(
      `operations overlap on ${overlap}; express the intended end state with one operation per target`,
    );
  }
}

export function assertSerializedBound(value: unknown, label: string): void {
  if (serializedBytes(value) > MAX_SERIALIZED_BYTES) {
    throw new BadRequestException(`${label} exceeds ${MAX_SERIALIZED_BYTES} bytes`);
  }
}
