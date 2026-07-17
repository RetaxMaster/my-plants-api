import { BadRequestException, Body, Controller, Delete, Get, Header, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import type { AgentProvider } from '@retaxmaster/agents-realtime-protocol';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { KnowledgeChatService } from '../knowledge-chat/knowledge-chat.service.js';
import { CreateRunDto, CreateSessionDto } from '../knowledge-chat/knowledge-chat.dto.js';
import { KNOWLEDGE_CHAT_PROVIDERS, type ChatEngine } from '../knowledge-chat/engine/knowledge-chat-engine.service.js';
import { DOCTOR_ENGINE } from '../knowledge-chat/engine/engine-params.js';
import { CodexRoleVerificationService, maskCodex } from '../knowledge-chat/codex-role-verification.service.js';
import type { SessionScope } from '../knowledge-chat/session-scope.js';

// Owner-scoped Plant Doctor chat surface — a THIN controller over the SHARED KnowledgeChatService (never a
// fork). It is owner-scoped by the global JwtAuthGuard + an explicit owned-plant check (NOT admin-only), and
// passes the DOCTOR scope tuple (kind=DOCTOR, plantId, ownerId) so the shared service enforces the boundary:
// a session id from another plant/owner is indistinguishable from not-found (Spec 3 §3.2). All state/run
// machinery is reused; only the auth scope + the engine (DOCTOR) differ from the admin KE controller.
@Controller('plants/:id/diagnose')
export class PlantDoctorController {
  constructor(
    private readonly chat: KnowledgeChatService,
    private readonly owner: OwnerService,
    private readonly prisma: PrismaService,
    @Inject(DOCTOR_ENGINE) private readonly engine: ChatEngine,
    private readonly codexVerification: CodexRoleVerificationService,
  ) {}

  // Resolve the DOCTOR scope for a plant this owner (or an admin acting-as them) actually owns; a plant that
  // is not owned 404s (never leaks existence). Every route builds the scope through here.
  private async scopeFor(plantId: string): Promise<SessionScope & { kind: 'DOCTOR' }> {
    const ownerId = this.owner.currentOwnerId(); // effective owner (own or admin acting-as)
    const plant = await this.prisma.plant.findFirst({ where: { id: plantId, ...this.owner.ownerFilter() } });
    if (!plant) throw new NotFoundException(`Unknown plant: ${plantId}`);
    return { kind: 'DOCTOR', plantId, ownerId };
  }

  @Get('sessions')
  async list(@Param('id') id: string) {
    return this.chat.listSessions(await this.scopeFor(id));
  }

  @Post('sessions')
  async create(@Param('id') id: string, @Body() dto: CreateSessionDto) {
    const scope = await this.scopeFor(id);
    return this.chat.createSession(dto.prompt, dto.provider, scope);
  }

  @Get('sessions/:sid')
  async detail(@Param('id') id: string, @Param('sid') sid: string) {
    return this.chat.getSession(sid, await this.scopeFor(id));
  }

  @Get('sessions/:sid/history')
  async history(@Param('id') id: string, @Param('sid') sid: string) {
    return this.chat.getSessionHistory(sid, await this.scopeFor(id));
  }

  @Post('sessions/:sid/runs')
  async resume(@Param('id') id: string, @Param('sid') sid: string, @Body() dto: CreateRunDto) {
    if (!!dto.prompt === !!dto.command) {
      throw new BadRequestException('Send exactly one of `prompt` or `command`.');
    }
    const input = dto.command
      ? { command: { name: dto.command.name, args: dto.command.args } }
      : { prompt: dto.prompt! };
    return this.chat.resume(sid, input, dto.provider, await this.scopeFor(id));
  }

  @Delete('sessions/:sid')
  async remove(@Param('id') id: string, @Param('sid') sid: string) {
    return this.chat.deleteSession(sid, await this.scopeFor(id));
  }

  @Post('runs/:runId/socket-ticket')
  async socketTicket(@Param('id') id: string, @Param('runId') runId: string) {
    // 404s if the run's session ≠ this (kind=DOCTOR, plantId=id, effective owner) — Spec 3 §3.2.
    return this.chat.mintSocketTicket(runId, await this.scopeFor(id));
  }

  // The doctor session detail emits a per-turn `logUrl` under this surface; serve it owner-scoped so a run's
  // transcript is reachable only through the pinned plant's owner (404s cross-plant/owner) — Spec 3 §3.2.
  @Get('runs/:runId/log')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async log(@Param('id') id: string, @Param('runId') runId: string) {
    return this.chat.getRunLog(runId, await this.scopeFor(id));
  }

  @Get('provider-status')
  async providerStatus(@Param('id') id: string, @Query('force') force?: string) {
    await this.scopeFor(id); // owned-plant check
    const statuses = await this.engine.providerStatus({ force: force === '1' || force === 'true' });
    return maskCodex(statuses as any, await this.codexVerification.isVerified('DOCTOR'));
  }

  @Get('commands')
  async commands(@Param('id') id: string, @Query('provider') provider: string, @Query('force') force?: string) {
    await this.scopeFor(id); // owned-plant check
    if (!(KNOWLEDGE_CHAT_PROVIDERS as readonly string[]).includes(provider)) {
      throw new BadRequestException(`Unknown provider: ${provider}`);
    }
    return this.engine.commandCatalog(provider as AgentProvider, { force: force === '1' || force === 'true' });
  }
}
