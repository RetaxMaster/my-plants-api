import { Type } from 'class-transformer';
import {
  IsIn, IsOptional, IsString, MaxLength, MinLength, Validate, ValidateNested,
  ValidatorConstraint, type ValidatorConstraintInterface,
} from 'class-validator';
import { isValidCommandName, MAX_COMMAND_ARGS_BYTES } from '@retaxmaster/agents-realtime-protocol';
import type { AgentProvider } from '@retaxmaster/agents-realtime-protocol';
import { KNOWLEDGE_CHAT_PROVIDERS } from './engine/knowledge-chat-engine.service.js';

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

// A research prompt. Capped generously (research prompts can be long) but bounded to avoid abuse.
export class CreateSessionDto {
  @IsString() @MinLength(1) @MaxLength(20_000) prompt!: string;

  // Which agent runs this conversation. Validated against the registry we actually configure, so a
  // request naming an agent the engine does not offer is rejected HERE with a 400 — instead of
  // travelling to the engine and coming back as an opaque 422. Whether that agent is *available*
  // (installed / signed in) is a separate, runtime question the engine's /execute gate answers; this
  // only checks the vocabulary.
  @IsIn([...KNOWLEDGE_CHAT_PROVIDERS]) provider!: AgentProvider;
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
}
