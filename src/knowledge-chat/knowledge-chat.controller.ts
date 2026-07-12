import { BadRequestException, Body, Controller, Delete, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { AgentProvider } from '@retaxmaster/agents-realtime-protocol';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CreateRunDto, CreateSessionDto } from './knowledge-chat.dto.js';
import { KNOWLEDGE_CHAT_PROVIDERS, KnowledgeChatEngineService } from './engine/knowledge-chat-engine.service.js';
import { KnowledgeChatService } from './knowledge-chat.service.js';

@Controller('knowledge-chat')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class KnowledgeChatController {
  constructor(
    private readonly chat: KnowledgeChatService,
    private readonly engine: KnowledgeChatEngineService,
  ) {}

  // Per-agent availability for the browser's agent picker. This is the HOST's authenticated proxy of the
  // engine's secret-gated answer: the browser never reaches the engine's control plane itself. The UI
  // uses it to offer only agents that can actually run, and to disable the rest WITH their reason (the
  // engine already scrubs those strings of tokens and home paths).
  // `?force=1` re-probes past the ~30s cache — for the "I just signed in, check again" button.
  @Get('provider-status')
  providerStatus(@Query('force') force?: string) {
    return this.engine.providerStatus({ force: force === '1' || force === 'true' });
  }

  // The agent's command catalog, proxied behind our admin auth (the browser never touches the engine's
  // control plane). Drives the composer's `/` autocomplete.
  @Get('commands')
  async commands(@Query('provider') provider: string, @Query('force') force?: string) {
    if (!(KNOWLEDGE_CHAT_PROVIDERS as readonly string[]).includes(provider)) {
      throw new BadRequestException(`Unknown provider: ${provider}`);
    }
    return this.engine.commandCatalog(provider as AgentProvider, { force: force === '1' || force === 'true' });
  }

  @Get('sessions')
  list() {
    return this.chat.listSessions();
  }

  @Post('sessions')
  create(@Body() dto: CreateSessionDto) {
    return this.chat.createSession(dto.prompt, dto.provider);
  }

  @Get('sessions/:id')
  detail(@Param('id') id: string) {
    return this.chat.getSession(id);
  }

  // The conversation's transcript as canonical AgentEvents, ready for the chat UI to seed. The browser
  // no longer parses raw agent output — that contract died with agents-realtime 1.0.0.
  @Get('sessions/:id/history')
  history(@Param('id') id: string) {
    return this.chat.getSessionHistory(id);
  }

  @Post('sessions/:id/runs')
  resume(@Param('id') id: string, @Body() dto: CreateRunDto) {
    // Both, or neither, is a malformed turn — the same 400 the engine's own /execute answers. Deciding it
    // here means a bad body never reaches the engine wearing a valid shape.
    if (!!dto.prompt === !!dto.command) {
      throw new BadRequestException('Send exactly one of `prompt` or `command`.');
    }
    const input = dto.command
      ? { command: { name: dto.command.name, args: dto.command.args } }
      : { prompt: dto.prompt! };
    return this.chat.resume(id, input, dto.provider);
  }

  @Delete('sessions/:id')
  remove(@Param('id') id: string) {
    return this.chat.deleteSession(id);
  }

  @Get('runs/:runId/log')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  log(@Param('runId') runId: string) {
    return this.chat.getRunLog(runId);
  }

  @Post('runs/:runId/socket-ticket')
  socketTicket(@Param('runId') runId: string) {
    return this.chat.mintSocketTicket(runId);
  }
}
