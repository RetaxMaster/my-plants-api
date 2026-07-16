import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

export type ImageErrorCode =
  | 'image_decode_failed'
  | 'image_unsupported_format'
  | 'image_animated'
  | 'image_too_large' // NEW (spec §2.2): decodes fine but exceeds MAX_IMAGE_PIXELS → 422
  | 'photo_storage_busy' // NEW (spec §3.2): inbox capacity floor hit / ENOSPC — try again later → 503
  | 'image_processing_timeout' // NEW (spec §4.3 / BLOCKER 6a): decode/PUT cancelled or timed out — a
  //   TRANSIENT signal (NOT in the worker's PERMANENT_CODES) → 503; never persisted as a failureCode
  | 'r2_not_configured';

// Thrown by ImageUploadService. Carries a stable `code` that the filter maps to a fixed HTTP status,
// so every consumer inherits the same contract and a known-bad image never surfaces as a raw 500.
export class ImageUploadError extends Error {
  constructor(readonly code: ImageErrorCode, message: string) {
    super(message);
    this.name = 'ImageUploadError';
  }
}

// The single source of the code→status mapping (spec §4.2). The invariant: typed code in, this
// status out — never a raw 500 for a known-bad image.
export const STATUS_BY_CODE: Record<ImageErrorCode, HttpStatus> = {
  image_decode_failed: HttpStatus.UNPROCESSABLE_ENTITY, // 422 — well-formed HTTP, unacceptable image
  image_unsupported_format: HttpStatus.UNPROCESSABLE_ENTITY, // 422
  image_animated: HttpStatus.UNPROCESSABLE_ENTITY, // 422
  image_too_large: HttpStatus.UNPROCESSABLE_ENTITY, // 422 — decodes but exceeds the pixel ceiling
  photo_storage_busy: HttpStatus.SERVICE_UNAVAILABLE, // 503 — inbox capacity floor / ENOSPC, retry later
  image_processing_timeout: HttpStatus.SERVICE_UNAVAILABLE, // 503 — cancelled/timed-out pipeline (transient)
  r2_not_configured: HttpStatus.SERVICE_UNAVAILABLE, // 503 — feature not configured on this host
};

// Global filter (registered via APP_FILTER in ImageUploadModule). @Catch is NARROWED to
// ImageUploadError, so it never interferes with any other exception in the app. Multer's own >10 MB
// rejection maps to 413 automatically via @nestjs/platform-express's built-in multer→HTTP transform,
// so it is deliberately NOT handled here.
@Catch(ImageUploadError)
export class ImageUploadExceptionFilter implements ExceptionFilter {
  catch(err: ImageUploadError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status = STATUS_BY_CODE[err.code];
    res.status(status).json({ statusCode: status, code: err.code, message: err.message });
  }
}
