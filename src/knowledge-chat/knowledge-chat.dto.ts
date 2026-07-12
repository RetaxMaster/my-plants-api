import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { AgentProvider } from '@retaxmaster/agents-realtime-protocol';
import { KNOWLEDGE_CHAT_PROVIDERS } from './engine/knowledge-chat-engine.service.js';

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
  @IsString() @MinLength(1) @MaxLength(20_000) prompt!: string;

  // OPTIONAL, and honored in exactly ONE case: the conversation's opening turn never got an agent off the
  // ground (no agent session id), so it is being RETRIED — possibly on a different agent, since no agent
  // memory exists yet for another one to contradict. Once a real agent session exists the conversation is
  // locked to its agent and this field is IGNORED: the server reads the agent off the session row, so a
  // client can never resume a Claude session on Codex.
  @IsOptional() @IsIn([...KNOWLEDGE_CHAT_PROVIDERS]) provider?: AgentProvider;
}
