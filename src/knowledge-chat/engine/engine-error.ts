import { HttpException } from '@nestjs/common';

/**
 * OUR stable, owner-facing error codes (spec §7). The engine has no code field — its `error` is free
 * English prose that interpolates caller-supplied input — so forwarding it would ship untranslated English
 * into a localized interface and make our tests assert on prose upstream is free to reword.
 *
 * The contract is: STATUS IN, OUR OWN TRANSLATED CODE OUT. The engine's body is logged server-side in full
 * and every non-status field is dropped at the boundary.
 */
export type EngineErrorCode =
  | 'attachments_unavailable'
  | 'attachment_write_failed'
  | 'attachment_corrupt'
  | 'attachment_too_large'
  | 'message_too_long'
  | 'payload_too_large'
  | 'request_failed';

/**
 * Status plus a REQUIRED prefix match. Status alone would give the user two names for everything and merge
 * cases whose correct advice is OPPOSITE ("this feature is not configured, tell an admin" versus "the disk
 * hiccuped, try again").
 *
 * The prefix match is EXPLICITLY A HEURISTIC OVER PROSE, NOT A CONTRACT, so it must FAIL SAFE.
 * Order matters: the specific 413 prefixes are listed before the broad `attachment` one.
 */
const PREFIX_RULES: ReadonlyArray<{ status: number; prefix: string; code: EngineErrorCode }> = [
  { status: 422, prefix: 'attachments are not configured', code: 'attachments_unavailable' },
  { status: 422, prefix: 'attachment path rejected', code: 'attachment_write_failed' },
  { status: 422, prefix: 'attachment write failed', code: 'attachment_write_failed' },
  { status: 422, prefix: 'attachment mimetype is not an allowed image type', code: 'attachment_corrupt' },
  { status: 422, prefix: 'attachment content does not match', code: 'attachment_corrupt' },
  { status: 413, prefix: 'composed prompt too large', code: 'message_too_long' },
  { status: 413, prefix: 'turn.input event too large', code: 'message_too_long' },
  // OUR DRIFT ALARM: the engine's own body parser refuses an oversized request BEFORE any attachment
  // validation runs. It can only fire if a local mirror constant in body-limit.ts drifted HIGH, which the
  // CI assertion there is designed to catch first.
  { status: 413, prefix: 'request body', code: 'payload_too_large' },
  { status: 413, prefix: 'attachment', code: 'attachment_too_large' },
];

/**
 * EVERY generic fallback is a NEUTRAL code, never one of its siblings. A sibling fallback is not a coarser
 * answer — it is a WRONG answer that happens to be in the right family.
 */
const NEUTRAL_BY_STATUS: Readonly<Record<number, EngineErrorCode>> = {
  413: 'payload_too_large',
  422: 'request_failed',
};

export type MappedEngineFailure = { code: EngineErrorCode; status: number };

/**
 * Maps EVERY non-OK status, not just the two enumerated: an unmapped status degrades to `request_failed`.
 * Never throws, never leaks the unmatched string.
 */
export function mapEngineFailure(status: number, body: unknown): MappedEngineFailure {
  const prose =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error.toLowerCase()
      : '';

  for (const rule of PREFIX_RULES) {
    if (rule.status === status && prose.startsWith(rule.prefix)) return { code: rule.code, status };
  }
  return { code: NEUTRAL_BY_STATUS[status] ?? 'request_failed', status };
}

/**
 * The typed exception that carries our code through Nest and the BFF to the browser. Only `code` and the
 * status cross the boundary — the engine's `error`, its `detail` (a raw Error.message that can contain
 * ABSOLUTE SERVER PATHS) and the 413s' numeric fields are all dropped under one rule. Surfacing a real
 * cause must not become a disclosure of the deployment's directory layout.
 */
export class EngineFailureException extends HttpException {
  constructor(readonly mapped: MappedEngineFailure) {
    super({ code: mapped.code }, mapped.status);
  }
}
