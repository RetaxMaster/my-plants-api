import { BadRequestException, Body, Controller, Delete, Get, Header, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { AgentProvider } from '@retaxmaster/agents-realtime-protocol';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CreateRunDto, CreateSessionDto } from './knowledge-chat.dto.js';
import { KNOWLEDGE_CHAT_PROVIDERS, type ChatEngine } from './engine/knowledge-chat-engine.service.js';
import { KNOWLEDGE_ENGINE } from './engine/engine-params.js';
import { KnowledgeChatService } from './knowledge-chat.service.js';
import { CodexRoleVerificationService, maskCodex } from './codex-role-verification.service.js';

// The admin Knowledge-Engine chat surface. Since the Plant Doctor it is a THIN controller over the shared
// KnowledgeChatService, passing the KNOWLEDGE scope so it provably only ever sees KNOWLEDGE sessions (never
// a doctor's), and it queries the KNOWLEDGE engine specifically. The doctor's owner-scoped controller is a
// sibling over the SAME service (reuse-not-fork, Spec 3 §3.2).
const KNOWLEDGE_SCOPE = { kind: 'KNOWLEDGE' } as const;

@Controller('knowledge-chat')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class KnowledgeChatController {
  constructor(
    private readonly chat: KnowledgeChatService,
    @Inject(KNOWLEDGE_ENGINE) private readonly engine: ChatEngine,
    private readonly codexVerification: CodexRoleVerificationService,
  ) {}

  @Get('provider-status')
  async providerStatus(@Query('force') force?: string) {
    const statuses = await this.engine.providerStatus({ force: force === '1' || force === 'true' });
    // Report Codex UNAVAILABLE while its roles are unverified for this pipeline — the same fact the run-path
    // gate enforces, so the picker and the gate cannot disagree (Spec 3 §3.2).
    return maskCodex(statuses as any, await this.codexVerification.isVerified('KNOWLEDGE'));
  }

  @Get('commands')
  async commands(@Query('provider') provider: string, @Query('force') force?: string) {
    if (!(KNOWLEDGE_CHAT_PROVIDERS as readonly string[]).includes(provider)) {
      throw new BadRequestException(`Unknown provider: ${provider}`);
    }
    return this.engine.commandCatalog(provider as AgentProvider, { force: force === '1' || force === 'true' });
  }

  @Get('sessions')
  list() {
    return this.chat.listSessions(KNOWLEDGE_SCOPE);
  }

  @Post('sessions')
  create(@Body() dto: CreateSessionDto) {
    return this.chat.createSession(dto.prompt, dto.provider, KNOWLEDGE_SCOPE, dto.attachments);
  }

  @Get('sessions/:id')
  detail(@Param('id') id: string) {
    return this.chat.getSession(id, KNOWLEDGE_SCOPE);
  }

  @Get('sessions/:id/history')
  history(@Param('id') id: string) {
    return this.chat.getSessionHistory(id, KNOWLEDGE_SCOPE);
  }

  @Post('sessions/:id/runs')
  resume(@Param('id') id: string, @Body() dto: CreateRunDto) {
    if (!!dto.prompt === !!dto.command) {
      throw new BadRequestException('Send exactly one of `prompt` or `command`.');
    }
    const input = dto.command
      ? { command: { name: dto.command.name, args: dto.command.args } }
      : { prompt: dto.prompt!, attachments: dto.attachments };
    return this.chat.resume(id, input, dto.provider, KNOWLEDGE_SCOPE);
  }

  @Delete('sessions/:id')
  remove(@Param('id') id: string) {
    return this.chat.deleteSession(id, KNOWLEDGE_SCOPE);
  }

  @Get('runs/:runId/log')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  log(@Param('runId') runId: string) {
    return this.chat.getRunLog(runId, KNOWLEDGE_SCOPE);
  }

  @Post('runs/:runId/socket-ticket')
  socketTicket(@Param('runId') runId: string) {
    return this.chat.mintSocketTicket(runId, KNOWLEDGE_SCOPE);
  }
}
