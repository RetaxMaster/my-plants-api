import { describe, expect, it, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { ImageUploadError, ImageUploadExceptionFilter, STATUS_BY_CODE } from './image-upload.errors.js';

function hostWith() {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as never;
  return { res, host };
}

describe('ImageUploadExceptionFilter', () => {
  it('maps every image_* code to 422 Unprocessable Entity', () => {
    for (const code of ['image_decode_failed', 'image_unsupported_format', 'image_animated'] as const) {
      const { res, host } = hostWith();
      new ImageUploadExceptionFilter().catch(new ImageUploadError(code, 'bad'), host);
      expect(res.status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code, statusCode: 422 }));
    }
  });

  it('maps r2_not_configured to 503 Service Unavailable', () => {
    const { res, host } = hostWith();
    new ImageUploadExceptionFilter().catch(new ImageUploadError('r2_not_configured', 'nope'), host);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'r2_not_configured', statusCode: 503 }));
  });

  it('STATUS_BY_CODE covers every code', () => {
    expect(STATUS_BY_CODE.image_decode_failed).toBe(422);
    expect(STATUS_BY_CODE.image_unsupported_format).toBe(422);
    expect(STATUS_BY_CODE.image_animated).toBe(422);
    expect(STATUS_BY_CODE.r2_not_configured).toBe(503);
  });
});
