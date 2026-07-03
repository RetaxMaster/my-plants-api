import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ImageUploadService } from './image-upload.service.js';
import { ImageUploadError } from './image-upload.errors.js';
import type { Env } from '../config/env.js';

// A fully-configured R2 env (fake values). Trailing slash on the public base URL is intentional —
// it exercises the trailing-slash trim in the returned URL.
const CONFIGURED = {
  R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'k',
  R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'bucket', R2_PUBLIC_BASE_URL: 'https://cdn.example.com/',
} as unknown as Env;

// Every R2 var empty → the optional-feature guard must fire. Passed as an object, so this path
// NEVER reads process.env → env-hermetic by construction (no delete/restore of ambient vars needed).
const UNCONFIGURED = {
  R2_ACCOUNT_ID: '', R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '', R2_BUCKET: '', R2_PUBLIC_BASE_URL: '',
} as unknown as Env;

// A valid 1x1 STILL GIF. Its decoded format is `gif` — not in the jpeg/png/webp allowlist — so it
// exercises the image_unsupported_format branch (spec §5 accepts this for the animated/unsupported
// case via its OR-clause).
const STILL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// The fake's `send` accepts `unknown` so it structurally satisfies the service's `S3Sender`
// interface (send(command: unknown): Promise<unknown>). Captured commands are recorded as
// `{ input }` for assertions on Bucket/Key/ContentType/etc.
function fakeS3() {
  const calls: { input: Record<string, unknown> }[] = [];
  const s3 = {
    send: vi.fn(async (cmd: unknown) => {
      calls.push(cmd as { input: Record<string, unknown> });
      return {};
    }),
  };
  return { calls, s3 };
}

describe('ImageUploadService.upload', () => {
  it('accepts a real PNG, re-encodes to WebP, returns a uuid .webp url + key', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 120, b: 40 } } }).png().toBuffer();
    const { calls, s3 } = fakeS3();
    const svc = new ImageUploadService(CONFIGURED, { s3, PutObjectCommand, DeleteObjectCommand });

    const out = await svc.upload({ buffer: png, keyPrefix: 'plants/p1/progress/' });

    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(calls[0].input.Bucket).toBe('bucket');
    expect(calls[0].input.ContentType).toBe('image/webp');
    expect(calls[0].input.CacheControl).toBe('public, max-age=31536000, immutable');
    expect(out.imageObjectKey).toMatch(/^plants\/p1\/progress\/[0-9a-f-]{36}\.webp$/);
    // Trailing slash on R2_PUBLIC_BASE_URL is trimmed; the key is appended once.
    expect(out.imageUrl).toBe(`https://cdn.example.com/${out.imageObjectKey}`);
    // The uploaded body is a real WebP (re-encoded, not the original PNG bytes).
    expect((await sharp(calls[0].input.Body as Buffer).metadata()).format).toBe('webp');
  });

  it('rejects a non-image buffer with image_decode_failed', async () => {
    const svc = new ImageUploadService(CONFIGURED, { s3: fakeS3().s3 });
    await expect(svc.upload({ buffer: Buffer.from('definitely not an image'), keyPrefix: 'x' }))
      .rejects.toMatchObject({ code: 'image_decode_failed' });
  });

  it('rejects a truncated image whose header decodes but body fails to re-encode with image_decode_failed', async () => {
    // A real 200x200 PNG cut to 100 bytes: metadata() parses the IHDR (format=png) but the pixel
    // data (IDAT) is incomplete, so the resize/encode pipeline rejects. This must map to the typed
    // image_decode_failed (422), never a raw 500 — the re-encode step is inside its own try/catch.
    const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 120, b: 40 } } }).png().toBuffer();
    const truncated = png.subarray(0, 100);
    const { s3 } = fakeS3();
    const svc = new ImageUploadService(CONFIGURED, { s3, PutObjectCommand, DeleteObjectCommand });
    await expect(svc.upload({ buffer: truncated, keyPrefix: 'x' }))
      .rejects.toMatchObject({ code: 'image_decode_failed' });
    // The upload must be rejected before any PutObject is attempted (no orphaned object).
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('rejects a non-allowlisted still format (GIF) with image_unsupported_format', async () => {
    const svc = new ImageUploadService(CONFIGURED, { s3: fakeS3().s3 });
    await expect(svc.upload({ buffer: STILL_GIF, keyPrefix: 'x' }))
      .rejects.toMatchObject({ code: 'image_unsupported_format' });
  });

  it('throws r2_not_configured when R2 env is empty (env-hermetic: never reads process.env)', async () => {
    const svc = new ImageUploadService(UNCONFIGURED, { s3: fakeS3().s3 });
    await expect(svc.upload({ buffer: Buffer.from('anything'), keyPrefix: 'x' }))
      .rejects.toBeInstanceOf(ImageUploadError);
    await expect(svc.upload({ buffer: Buffer.from('anything'), keyPrefix: 'x' }))
      .rejects.toMatchObject({ code: 'r2_not_configured' });
  });
});

describe('ImageUploadService.delete', () => {
  it('is a no-op on an empty/null/undefined key and never calls the client', async () => {
    const { s3 } = fakeS3();
    const svc = new ImageUploadService(CONFIGURED, { s3, DeleteObjectCommand });
    await svc.delete('');
    await svc.delete(null);
    await svc.delete(undefined);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('sends a DeleteObjectCommand for a real key', async () => {
    const { calls, s3 } = fakeS3();
    const svc = new ImageUploadService(CONFIGURED, { s3, DeleteObjectCommand });
    await svc.delete('plants/p1/progress/abc.webp');
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(calls[0].input.Bucket).toBe('bucket');
    expect(calls[0].input.Key).toBe('plants/p1/progress/abc.webp');
  });
});
