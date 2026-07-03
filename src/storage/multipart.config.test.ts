import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, imageUploadMulterOptions } from './multipart.config.js';

describe('imageUploadMulterOptions', () => {
  it('caps each file at 10 MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(imageUploadMulterOptions.limits?.fileSize).toBe(10 * 1024 * 1024);
  });

  it('uses memory storage and NO fileFilter (client MIME is not trusted at the transport layer)', () => {
    expect(imageUploadMulterOptions.storage).toBeDefined();
    expect((imageUploadMulterOptions as { fileFilter?: unknown }).fileFilter).toBeUndefined();
  });
});
