import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Env } from '../config/env.js';
import { ImageUploadError } from './image-upload.errors.js';

// Deliberate tuning knobs (spec §2 — plant photos, not thumbnails). Kept as named constants so they
// are trivial to tune. Deviations from the rizzytos reference: 1600 box (was 1280×720), q82 (was 80).
const MAX_BOX = 1600; // max width AND height; images scale to fit INSIDE 1600×1600.
const WEBP_QUALITY = 82;
const MAX_INPUT_PIXELS = 24_000_000; // 24 MP decompression-bomb guard.
const ALLOWED_FORMATS = ['jpeg', 'png', 'webp'] as const;

// `sharp` uses `export = sharp` with `Metadata` living in the `sharp` namespace. Under the API's
// strict `tsc` build the default-imported binding is a value, so `sharp.Metadata` as a type resolves
// to TS2503 ("Cannot find namespace 'sharp'"). Deriving the type from `.metadata()`'s return keeps
// it namespace-free and correct across sharp versions.
type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;

export interface StoredImage {
  imageUrl: string;
  imageObjectKey: string;
}

// Narrow structural type for the only S3 capability we use: `send`. We do NOT use
// `Pick<S3Client, 'send'>` because `S3Client.send` is an overloaded generic method whose real
// signature a plain `{ send: vi.fn() }` fake cannot satisfy under strict TS. A real `S3Client`
// still assigns to this interface structurally, and the test fake satisfies it cleanly without any
// casting. `send` accepts a command instance (PutObjectCommand/DeleteObjectCommand) and resolves.
export interface S3Sender {
  send(command: unknown): Promise<unknown>;
}

// Test seam: unit tests pass a fake S3 client (capturing PutObject/DeleteObject inputs) plus the
// real command classes, exactly as the rizzytos reference does. In production ImageUploadModule
// builds the service with just the Env (via useFactory), and the S3 client is created lazily from
// R2 config on first use — so the app boots without R2.
export interface ImageUploadDeps {
  s3?: S3Sender;
  PutObjectCommand?: typeof PutObjectCommand;
  DeleteObjectCommand?: typeof DeleteObjectCommand;
}

export class ImageUploadService {
  private readonly PutObjectCommand: typeof PutObjectCommand;
  private readonly DeleteObjectCommand: typeof DeleteObjectCommand;
  private s3Client?: S3Sender;

  constructor(
    private readonly env: Env,
    deps: ImageUploadDeps = {},
  ) {
    this.PutObjectCommand = deps.PutObjectCommand ?? PutObjectCommand;
    this.DeleteObjectCommand = deps.DeleteObjectCommand ?? DeleteObjectCommand;
    this.s3Client = deps.s3;
  }

  // The S3 endpoint is derived from the Cloudflare account id (there is no separate R2_ENDPOINT env
  // var — it would only ever duplicate this value).
  private endpoint(): string {
    return this.env.R2_ACCOUNT_ID ? `https://${this.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '';
  }

  // Optional-feature guard (spec §3.2): fail fast with a typed 503 when R2 isn't configured on this
  // host. Names the missing vars by NAME only — never their values (Security).
  private assertConfigured(): void {
    const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL } = this.env;
    if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_BASE_URL || !this.endpoint()) {
      throw new ImageUploadError(
        'r2_not_configured',
        'R2 image storage is not configured (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET/R2_PUBLIC_BASE_URL/R2_ACCOUNT_ID).',
      );
    }
  }

  private client(): S3Sender {
    if (!this.s3Client) {
      this.s3Client = new S3Client({
        region: 'auto',
        endpoint: this.endpoint(),
        credentials: {
          accessKeyId: this.env.R2_ACCESS_KEY_ID,
          secretAccessKey: this.env.R2_SECRET_ACCESS_KEY,
        },
      });
    }
    return this.s3Client;
  }

  // Validate-by-decode → compress → PutObject → return url + key.
  async upload(input: { buffer: Buffer; keyPrefix: string }): Promise<StoredImage> {
    this.assertConfigured();

    // Never trust the client-declared MIME: decode and inspect the REAL metadata.
    let meta: SharpMetadata;
    try {
      meta = await sharp(input.buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    } catch {
      throw new ImageUploadError('image_decode_failed', 'invalid image: could not decode');
    }
    if (!meta.format || !ALLOWED_FORMATS.includes(meta.format as (typeof ALLOWED_FORMATS)[number])) {
      throw new ImageUploadError('image_unsupported_format', `unsupported image format: ${meta.format ?? 'unknown'}`);
    }
    if (meta.pages && meta.pages > 1) {
      throw new ImageUploadError('image_animated', 'unsupported image: animated/multi-page not allowed');
    }

    // Re-encode can still reject even after metadata() succeeded: a truncated/corrupt body (e.g. a
    // JPEG/PNG whose header parses but whose pixel data is incomplete) fails during the actual decode
    // inside this pipeline. That rejection must NOT escape as a raw 500 — it is a known-bad image, so
    // map it to the same typed image_decode_failed → 422 contract as a metadata() failure (spec §4.2).
    let out: Buffer;
    try {
      out = await sharp(input.buffer, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate() // bake EXIF orientation into pixels; EXIF is then dropped on re-encode
        .resize({ width: MAX_BOX, height: MAX_BOX, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
    } catch {
      throw new ImageUploadError('image_decode_failed', 'invalid image: could not decode/re-encode');
    }

    // Immutable random-UUID key (NOT content-addressed). Always `.webp`.
    const key = `${input.keyPrefix.replace(/\/$/, '')}/${randomUUID()}.webp`;
    await this.client().send(
      new this.PutObjectCommand({
        Bucket: this.env.R2_BUCKET,
        Key: key,
        Body: out,
        ContentType: 'image/webp',
        // Safe long-lived cache: the key never changes for a given object.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    const base = this.env.R2_PUBLIC_BASE_URL.replace(/\/$/, '');
    return { imageUrl: `${base}/${key}`, imageObjectKey: key };
  }

  // Best-effort delete used when an owning row is removed/replaced. No-op on an empty key; never
  // throws into the caller's happy path — a failed cleanup must not fail the request.
  async delete(objectKey: string | null | undefined): Promise<void> {
    if (!objectKey) return;
    try {
      await this.client().send(new this.DeleteObjectCommand({ Bucket: this.env.R2_BUCKET, Key: objectKey }));
    } catch {
      // swallow: best-effort cleanup
    }
  }
}
