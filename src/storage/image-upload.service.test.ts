import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { deflateSync } from 'node:zlib';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ImageUploadService } from './image-upload.service.js';
import { ImageUploadError } from './image-upload.errors.js';
import type { Env } from '../config/env.js';

// Build a real but TINY PNG that DECLARES width×height in its IHDR (no pixel data). sharp.metadata()
// reads the header and reports those dimensions without decoding — so the dimension guard can be tested
// at 72 MP without ever allocating a 72 MP buffer. (A crafted header cannot be re-encoded, so it only
// exercises the metadata dimension check, which fires BEFORE the decode pipeline.)
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function pngHeaderOf(width: number, height: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, RGB
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.alloc(0))), pngChunk('IEND', Buffer.alloc(0))]);
}

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
    // Additive return fields: exact stored byte length + post-resize dimensions (no second decode).
    expect(out.sizeBytes).toBeGreaterThan(0);
    expect(out.sizeBytes).toBe((calls[0].input.Body as Buffer).length);
    expect(out.width).toBe(4); // 4x4 source, withoutEnlargement -> unchanged
    expect(out.height).toBe(4);
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

describe('ImageUploadService.upload — raised pixel guard + explicit key (Task 5)', () => {
  it('raises image_too_large by DIMENSION COMPARE, not by matching a libvips string', async () => {
    // metadata() reports 9000×8000 = 72 MP from the crafted header (read with limitInputPixels:false so it
    // never throws first); the explicit width*height > MAX_IMAGE_PIXELS (64 MP) compare is what rejects.
    const { s3 } = fakeS3();
    const svc = new ImageUploadService(CONFIGURED, { s3, PutObjectCommand, DeleteObjectCommand });
    await expect(svc.upload({ buffer: pngHeaderOf(9000, 8000), key: 'plants/p1/progress/ph1-tok1.webp' }))
      .rejects.toMatchObject({ code: 'image_too_large' });
    expect(s3.send).not.toHaveBeenCalled(); // rejected before any PutObject
  });

  it('accepts an image just UNDER the ceiling (a real small image passes the dimension guard)', async () => {
    // The guard is a pure dimension compare, so a real small image (64 px ≪ 64 MP) proves the accept side
    // without allocating a 56 MP buffer; the real pipeline then encodes it and PutObject is captured.
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 5, g: 5, b: 5 } } }).png().toBuffer();
    const { s3 } = fakeS3();
    const svc = new ImageUploadService(CONFIGURED, { s3, PutObjectCommand, DeleteObjectCommand });
    await expect(svc.upload({ buffer: png, key: 'plants/p1/progress/ph1-tok1.webp' })).resolves.toBeDefined();
  });

  it('writes to the EXPLICIT unique-per-claim key it is given (no random UUID)', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const { calls, s3 } = fakeS3();
    const svc = new ImageUploadService(CONFIGURED, { s3, PutObjectCommand, DeleteObjectCommand });
    const stored = await svc.upload({ buffer: png, key: 'plants/p1/progress/ph1-tok1.webp' });
    expect(stored.imageObjectKey).toBe('plants/p1/progress/ph1-tok1.webp');
    expect(calls[0].input.Key).toBe('plants/p1/progress/ph1-tok1.webp');
  });

  it('still raises image_decode_failed for a genuinely corrupt image (explicit key)', async () => {
    const { s3 } = fakeS3();
    const svc = new ImageUploadService(CONFIGURED, { s3, PutObjectCommand, DeleteObjectCommand });
    await expect(svc.upload({ buffer: Buffer.from('corrupt'), key: 'plants/p1/progress/ph1-tok1.webp' }))
      .rejects.toMatchObject({ code: 'image_decode_failed' });
  });
});

describe('ImageUploadService.confirmDelete — propagates failure (BLOCKER 4)', () => {
  // A fake whose send() applies a per-test outcome (resolve / reject with an armed error).
  function s3WithSend(send: (cmd: unknown) => Promise<unknown>) {
    return { send: vi.fn(send) };
  }

  it('resolves on a confirmed R2 delete success', async () => {
    const svc = new ImageUploadService(CONFIGURED, { s3: s3WithSend(async () => ({})), DeleteObjectCommand });
    await expect(svc.confirmDelete('plants/p1/progress/ph1-tok1.webp')).resolves.toBeUndefined();
  });

  it('resolves when R2 confirms the object is ALREADY ABSENT (404/NoSuchKey)', async () => {
    const svc = new ImageUploadService(CONFIGURED, {
      s3: s3WithSend(async () => { throw Object.assign(new Error('gone'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }); }),
      DeleteObjectCommand,
    });
    await expect(svc.confirmDelete('plants/p1/progress/ph1-tok1.webp')).resolves.toBeUndefined();
  });

  it('REJECTS on an unconfirmed delete (network/5xx) — never a false success', async () => {
    const svc = new ImageUploadService(CONFIGURED, {
      s3: s3WithSend(async () => { throw Object.assign(new Error('unreachable'), { $metadata: { httpStatusCode: 503 } }); }),
      DeleteObjectCommand,
    });
    await expect(svc.confirmDelete('plants/p1/progress/ph1-tok1.webp')).rejects.toBeDefined();
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
