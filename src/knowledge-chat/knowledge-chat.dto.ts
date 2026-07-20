import { Type } from 'class-transformer';
import {
  IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength, Validate, ValidateNested,
  ValidatorConstraint, type ValidatorConstraintInterface, type ValidationArguments,
} from 'class-validator';
import {
  isValidCommandName, MAX_COMMAND_ARGS_BYTES,
  MAX_ATTACHMENT_ID_BYTES, MAX_ATTACHMENT_FILENAME_BYTES, MAX_ATTACHMENT_MIME_BYTES,
} from '@retaxmaster/agents-realtime-protocol';
import type { AgentProvider } from '@retaxmaster/agents-realtime-protocol';
import { KNOWLEDGE_CHAT_PROVIDERS } from './engine/knowledge-chat-engine.service.js';
import { ATTACHMENT_CAPS, ALLOWED_ATTACHMENT_MIMES } from './engine/body-limit.js';

// The NAME rule is the PROTOCOL's (`isValidCommandName`) — imported, never re-derived. A second copy of that
// regex is how `/postman:docs` (a namespaced plugin skill — colons are legal, on purpose) would silently stop
// validating here while the engine still accepted it.
//
// Declared BEFORE the DTO that uses it: a decorator argument is evaluated at class-definition time, so a
// class referenced before its declaration is a TDZ error at import, not a lint nit.
@ValidatorConstraint({ name: 'isValidCommandName' })
export class IsValidCommandName implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidCommandName(value);
  }
  defaultMessage(): string {
    return 'name must be a valid command name';
  }
}

// MAX_COMMAND_ARGS_BYTES is a BYTE cap (it mirrors the engine's own pre-acceptance 413 check, which reads
// the wire body as bytes). `@MaxLength` counts UTF-16 CODE UNITS, not bytes — so e.g. 8,000 emoji (each
// 2 UTF-16 units, but 4 UTF-8 bytes) would sail through `@MaxLength(MAX_COMMAND_ARGS_BYTES)` and then get
// rejected by the engine, turning a request we accepted into a run we create and immediately fail. Declared
// BEFORE the DTO that uses it, same reason as `IsValidCommandName` above (decorator args evaluate at
// class-definition time).
@ValidatorConstraint({ name: 'isWithinCommandArgsByteLimit' })
export class IsWithinCommandArgsByteLimit implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_COMMAND_ARGS_BYTES;
  }
  defaultMessage(): string {
    return `args must not exceed ${MAX_COMMAND_ARGS_BYTES} bytes (UTF-8)`;
  }
}

// A command as typed by the user: a bare name and its raw argument string, verbatim.
export class AgentCommandDto {
  @IsString() @Validate(IsValidCommandName) name!: string;

  @IsString() @Validate(IsWithinCommandArgsByteLimit) args!: string;
}

/**
 * API-OWNED validation (spec §4.1.1). The split between us and the engine is defined by OWNERSHIP, not by a
 * list that goes stale on the next release: we check what WE declare or import — the caps we configure on
 * the engine, the MIME allowlist, the published MAX_ATTACHMENT_* bounds, and JSON/base64 ENCODING
 * well-formedness. Content SEMANTICS (magic bytes vs declared MIME), the filesystem, and the composed turn
 * belong to the engine.
 *
 * That discriminator answers for a content check the next release invents; "who can see the bytes" does
 * not — it classifies magic-byte sniffing and base64 validity backwards.
 *
 * The engine independently re-validates everything regardless. This is a fast local refusal so a malformed
 * envelope never reaches it, not a substitute for its authority.
 *
 * Declared BEFORE the DTOs that use them, same reason as `IsValidCommandName` above (decorator arguments
 * are evaluated at class-definition time).
 */
@ValidatorConstraint({ name: 'isBase64Payload' })
export class IsBase64Payload implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    return Buffer.from(value, 'base64').toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '');
  }
  defaultMessage(): string {
    return 'data must be valid base64';
  }
}

/**
 * The EXACT decoded size of a base64 payload, in bytes.
 *
 * `Buffer.byteLength(s, 'base64')` computes this from the string's length and padding WITHOUT allocating
 * or decoding, so it is cheap enough to run on every attachment of every request.
 *
 * The obvious `Math.floor((s.length * 3) / 4)` is NOT equivalent and was a real defect: for a raw size
 * that is not a multiple of 3, base64 pads to `4*ceil(n/3)`, and that formula rounds the answer UP to the
 * next multiple of 3. Six attachments of arbitrary real-world sizes could therefore be estimated up to
 * `maxCount * 2` bytes heavier than they are — enough to refuse a payload that is genuinely UNDER the cap.
 * It erred toward rejecting rather than over-accepting, so it was never a safety hole, but "your images
 * are too large" for images that are not is still a lie the owner cannot act on.
 */
const decodedBase64Bytes = (s: string): number => Buffer.byteLength(s, 'base64');

@ValidatorConstraint({ name: 'isWithinAttachmentFileBytes' })
export class IsWithinAttachmentFileBytes implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    // Decoded size, not the base64 length — the cap is over the image, not over its encoding.
    return decodedBase64Bytes(value) <= ATTACHMENT_CAPS.maxFileBytes;
  }
  defaultMessage(): string {
    return `each attachment must not exceed ${ATTACHMENT_CAPS.maxFileBytes} bytes`;
  }
}

@ValidatorConstraint({ name: 'isWithinAttachmentByteBound' })
export class IsWithinAttachmentByteBound implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const [max] = args.constraints as [number];
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max;
  }
  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be non-empty and at most ${(args.constraints as [number])[0]} bytes`;
  }
}

export class AttachmentDto {
  @IsString() @Validate(IsWithinAttachmentByteBound, [MAX_ATTACHMENT_ID_BYTES]) id!: string;
  @IsString() @Validate(IsWithinAttachmentByteBound, [MAX_ATTACHMENT_FILENAME_BYTES]) filename!: string;
  @IsString()
  @Validate(IsWithinAttachmentByteBound, [MAX_ATTACHMENT_MIME_BYTES])
  @IsIn([...ALLOWED_ATTACHMENT_MIMES])
  mimeType!: string;
  @IsString() @Validate(IsBase64Payload) @Validate(IsWithinAttachmentFileBytes) data!: string;
}

@ValidatorConstraint({ name: 'isValidAttachmentSet' })
export class IsValidAttachmentSet implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined) return true;
    if (!Array.isArray(value)) return false;
    const items = value as AttachmentDto[];
    if (items.length > ATTACHMENT_CAPS.maxCount) return false;
    // Commands never carry attachments: the engine answers 400 to a body with both, so we make the
    // combination unrepresentable rather than discovering it at runtime. Cast through a narrow structural
    // type rather than either DTO class — CreateRunDto is declared below this constraint (decorator
    // arguments evaluate at class-definition time) and CreateSessionDto has no `command` at all, which is
    // fine: the check simply never fires there.
    if ((args.object as { command?: unknown }).command !== undefined && items.length > 0) return false;
    const ids = new Set(items.map((i) => i?.id));
    if (ids.size !== items.length) return false;
    const total = items.reduce((sum, i) => sum + (typeof i?.data === 'string' ? decodedBase64Bytes(i.data) : 0), 0);
    return total <= ATTACHMENT_CAPS.maxTotalBytes;
  }
  defaultMessage(): string {
    return `attachments must be at most ${ATTACHMENT_CAPS.maxCount} unique images totalling at most ${ATTACHMENT_CAPS.maxTotalBytes} bytes, and may never accompany a command`;
  }
}

// A research prompt. Capped generously (research prompts can be long) but bounded to avoid abuse.
export class CreateSessionDto {
  @IsString() @MinLength(1) @MaxLength(20_000) prompt!: string;

  // Which agent runs this conversation. Validated against the registry we actually configure, so a
  // request naming an agent the engine does not offer is rejected HERE with a 400 — instead of
  // travelling to the engine and coming back as an opaque 422. Whether that agent is *available*
  // (installed / signed in) is a separate, runtime question the engine's /execute gate answers; this
  // only checks the vocabulary.
  @IsIn([...KNOWLEDGE_CHAT_PROVIDERS]) provider!: AgentProvider;

  // OPTIONAL: the opening turn may itself carry photos (spec §4.1.1). class-validator's global
  // `ValidationPipe({ whitelist: true })` silently STRIPS any undeclared property — without this field,
  // `attachments` would vanish from the request with no error at all.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  @Validate(IsValidAttachmentSet)
  attachments?: AttachmentDto[];
}

export class CreateRunDto {
  // EXACTLY ONE of these two. class-validator cannot express "xor" declaratively, so the controller checks
  // it and answers 400 — mirroring the engine's own /execute, which rejects both-or-neither with a 400.
  @IsOptional() @IsString() @MinLength(1) @MaxLength(20_000) prompt?: string;

  @IsOptional() @ValidateNested() @Type(() => AgentCommandDto) command?: AgentCommandDto;

  // OPTIONAL, and honored in exactly ONE case: the conversation's opening turn never got an agent off the
  // ground (no agent session id), so it is being RETRIED — possibly on a different agent, since no agent
  // memory exists yet for another one to contradict. Once a real agent session exists the conversation is
  // locked to its agent and this field is IGNORED: the server reads the agent off the session row, so a
  // client can never resume a Claude session on Codex.
  @IsOptional() @IsIn([...KNOWLEDGE_CHAT_PROVIDERS]) provider?: AgentProvider;

  // OPTIONAL, and forbidden alongside `command` (see IsValidAttachmentSet) — see the field comment on
  // CreateSessionDto.attachments for why this must be declared, not just typed.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  @Validate(IsValidAttachmentSet)
  attachments?: AttachmentDto[];
}
