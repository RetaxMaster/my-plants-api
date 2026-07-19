import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';

export type ProposalFailureCode = 'VALIDATION' | 'NOT_FOUND' | 'OWNERSHIP' | 'CONFLICT' | 'INTERNAL';

/**
 * Author-written, agent- and owner-visible. Never derived from an exception message.
 *
 * This indirection is the whole point of the module: a write core's exception routinely carries a
 * plant id, a place id or a column name, and this text reaches BOTH the owner's approval banner and
 * the agent. One closed set of five sentences means nothing internal can escape through either.
 */
const REASONS: Record<ProposalFailureCode, string> = {
  VALIDATION: 'One of the requested changes was not valid for this plant.',
  NOT_FOUND: 'Something the request referred to no longer exists.',
  OWNERSHIP: 'The request referred to a record that does not belong to this plant or owner.',
  CONFLICT: 'The record was busy or already changed, so the request could not be applied.',
  INTERNAL: 'The request could not be applied because of an internal error.',
};

export const MAX_FAILURE_REASON_CHARS = 200;

/**
 * Maps a thrown error onto the closed enum + a sanitized message.
 * The RAW error text goes to the log ONLY (spec 5.7 item 4) — it must never reach
 * the API response, the banner, or the agent, because it leaks schema and infra detail.
 */
export function classifyFailure(
  err: unknown,
  logger: { warn: (message: string, ...rest: unknown[]) => void },
): { code: ProposalFailureCode; reason: string } {
  logger.warn(`proposal apply failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);

  let code: ProposalFailureCode = 'INTERNAL';
  if (err instanceof BadRequestException) code = 'VALIDATION';
  else if (err instanceof NotFoundException) code = 'NOT_FOUND';
  else if (err instanceof ForbiddenException) code = 'OWNERSHIP';
  else if (err instanceof ConflictException) code = 'CONFLICT';
  else if (err instanceof HttpException && err.getStatus() === 422) code = 'VALIDATION';

  return { code, reason: REASONS[code].slice(0, MAX_FAILURE_REASON_CHARS) };
}
