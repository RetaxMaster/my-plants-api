import {
  MAX_ATTACHMENT_ID_BYTES,
  MAX_ATTACHMENT_FILENAME_BYTES,
  MAX_ATTACHMENT_MIME_BYTES,
  MAX_PROMPT_BYTES,
  IMAGE_MIME_ALLOWLIST,
  DEFAULT_ATTACHMENT_MAX_COUNT,
  DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
  DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES,
  DEFAULT_UPLOAD_TTL_MS,
} from '@retaxmaster/agents-realtime-protocol';

/**
 * THE SINGLE DECLARATION of our attachment caps (spec §4.1). Declared ONCE here and handed to BOTH the
 * engine config and the request DTO, so the API and the engine cannot disagree about what is acceptable.
 *
 * The VALUES are IMPORTED, never copied. The protocol package exports all four of them, and the project's
 * no-fork rule forbids re-declaring a published constant: a hardcoded byte count that stops matching the
 * package's own value drifts SILENTLY, which is precisely the bug the CI drift alarm below exists to
 * catch. The alarm must guard an IMPORT, not a copy — otherwise it only ever checks our copy against
 * itself. What stays local is the DERIVATION (requiredBodyBytes), which is what spec §4.1 actually asks
 * us to own.
 */
export const ATTACHMENT_CAPS = {
  maxCount: DEFAULT_ATTACHMENT_MAX_COUNT,
  maxFileBytes: DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
  maxTotalBytes: DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES,
} as const;

/**
 * The image types the API accepts. SVG is deliberately excluded: no fixed magic number, executable doc.
 *
 * NOTE the spread: `IMAGE_MIME_ALLOWLIST` is a `ReadonlySet<string>`, NOT an array. Assigning it directly
 * to a `readonly string[]` does not compile, and `class-validator`'s `@IsIn` needs an array anyway.
 */
export const ALLOWED_ATTACHMENT_MIMES: readonly string[] = [...IMAGE_MIME_ALLOWLIST];

/** Attachment retention on the engine side — how long the AGENT can re-examine an earlier image. */
export const UPLOAD_TTL_MS = DEFAULT_UPLOAD_TTL_MS;

// -- Local mirrors of UNEXPORTED package internals ----------------------------------------------------
// The package's own `requiredBodyBytes()` is internal and unexported, so we declare our own — deliberately
// mirroring its SHAPE so the two cannot drift structurally even though we cannot call it. Each constant
// below is a mirror of a value the package does not export; it CAN drift on a package upgrade, which is
// exactly what body-limit.test.ts's drift alarm exists to catch. "Some metadata" and "a margin" are not
// implementable, so these carry committed numeric values rather than prose.
/** Worst case a single byte of metadata expands to under JSON string escaping. */
const JSON_ESCAPE_WORST_CASE = 6;
/** Per-attachment JSON structure: braces, four keys, quotes and commas. */
const PER_ATTACHMENT_JSON_OVERHEAD = 80;
/** The turn-framing the engine composes around the prompt. */
const FRAMING_OVERHEAD = 1024;
/**
 * Everything else in the request envelope: runId, provider, logPath, resumeSessionId — and `env`.
 * `env` RIDES THIS SAME BODY and the Plant Doctor is the surface that fills it: every doctor run injects a
 * per-run env carrying the session workspace path and a scoped JWT. This allowance bounds that
 * contribution. It is an ALLOWANCE, not an enforced cap — Task 15's near-max test runs on the DOCTOR
 * surface precisely so a populated env is exercised against it.
 */
const REQUEST_ENVELOPE = 65536;

/** Bytes a raw payload occupies once base64-encoded. */
const base64Bytes = (raw: number): number => Math.ceil(raw / 3) * 4;

export type AttachmentCaps = { maxCount: number; maxFileBytes: number; maxTotalBytes: number };

/**
 * The body limit our API must accept, DERIVED FROM the caps (spec §4.1).
 *
 * Note `maxFileBytes` is deliberately absent: the total already bounds the payload, and consuming the
 * per-file cap as well would double-count. That is why the "raise a cap and watch the limit follow" test
 * raises `maxTotalBytes`, not `maxFileBytes`.
 *
 * Note also that MAX_PROMPT_BYTES caps the COMPOSED string — prompt plus system message together — so it
 * is counted ONCE. Counting it twice would silently double the intended headroom.
 */
export function requiredBodyBytes(caps: AttachmentCaps): number {
  const attachments =
    base64Bytes(caps.maxTotalBytes) +
    caps.maxCount *
      ((MAX_ATTACHMENT_ID_BYTES + MAX_ATTACHMENT_FILENAME_BYTES + MAX_ATTACHMENT_MIME_BYTES) *
        JSON_ESCAPE_WORST_CASE +
        PER_ATTACHMENT_JSON_OVERHEAD);
  return attachments + MAX_PROMPT_BYTES + FRAMING_OVERHEAD + REQUEST_ENVELOPE;
}

/** The concrete limit this deployment configures on the Nest body parser. */
export const API_BODY_LIMIT_BYTES = requiredBodyBytes(ATTACHMENT_CAPS);
