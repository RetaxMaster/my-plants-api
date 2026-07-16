import { describe, expect, it } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { PhotoStatus, PhotoFailureKind } from '@prisma/client';
import {
  PHOTO_STATUSES,
  PHOTO_FAILURE_KINDS,
  PHOTO_FAILURE_CODES,
} from '@retaxmaster/my-plants-species-schema/photo-contract-constants';
import { STATUS_BY_CODE } from '../storage/image-upload.errors.js'; // the REAL API error registry
import { PERMANENT_CODES, WORKER_ONLY_FAILURE_CODES } from '../photo-worker/photo-worker.service.js'; // real worker exports

// The API must never silently diverge from the shared photo contract (BLOCKER 7). The Prisma enums are a
// generated duplication of the shared value sets; this test fails the moment the two disagree. The failureCode
// assertion is deliberately NON-tautological: it reconstructs the set the API actually persists from REAL code
// paths (the pipeline's 422 image faults in STATUS_BY_CODE + the worker's WORKER_ONLY_FAILURE_CODES) and
// compares THAT to the shared union — never a copy of the shared array compared to itself.
describe('API ↔ shared photo-contract parity', () => {
  it('the Prisma PhotoStatus enum equals the shared PHOTO_STATUSES set', () => {
    expect(Object.values(PhotoStatus).sort()).toEqual([...PHOTO_STATUSES].sort());
  });

  it('the Prisma PhotoFailureKind enum equals the shared PHOTO_FAILURE_KINDS set', () => {
    expect(Object.values(PhotoFailureKind).sort()).toEqual([...PHOTO_FAILURE_KINDS].sort());
  });

  it('the failureCodes the API ACTUALLY persists equal the shared PHOTO_FAILURE_CODES set', () => {
    // Reconstruct the persisted set ONLY from the API's genuine write sources — NEVER from PERMANENT_CODES,
    // which is itself DERIVED from PHOTO_FAILURE_CODES and would tautologically re-inject any dropped code:
    //  1. the permanent image faults the sharp pipeline throws — every ImageErrorCode mapped to 422 in the
    //     real registry (image_decode_failed, image_unsupported_format, image_animated, image_too_large);
    //  2. the worker's WORKER_ONLY_FAILURE_CODES — the codes the worker assigns directly (inbox_lost,
    //     upload_failed).
    // Deliberately EXCLUDED: the 503 codes photo_storage_busy / image_processing_timeout / r2_not_configured
    // are request/internal signals and are NEVER written to the failure_code column.
    const persistedImageFaults = Object.entries(STATUS_BY_CODE)
      .filter(([, status]) => status === HttpStatus.UNPROCESSABLE_ENTITY)
      .map(([code]) => code);
    const apiPersisted = new Set<string>([...persistedImageFaults, ...WORKER_ONLY_FAILURE_CODES]);
    expect([...apiPersisted].sort()).toEqual([...PHOTO_FAILURE_CODES].sort());
  });

  it('the worker PERMANENT_CODES is exactly the shared set minus the single transient-terminal code', () => {
    // A SEPARATE invariant (not part of the persisted-set reconstruction above): the retryability classifier.
    const expectedPermanent = [...PHOTO_FAILURE_CODES].filter((c) => c !== 'upload_failed').sort();
    expect([...PERMANENT_CODES].sort()).toEqual(expectedPermanent);
  });
});
