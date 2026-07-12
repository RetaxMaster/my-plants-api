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

// A command as typed by the user: a bare name and its raw argument string, verbatim.
export class AgentCommandDto {
  @IsString() @Validate(IsValidCommandName) name!: string;

  @IsString() @MaxLength(MAX_COMMAND_ARGS_BYTES) args!: string;
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
