import { Body, Controller, Delete, Get, Header, Param, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CreateRunDto, CreateSessionDto } from './knowledge-chat.dto.js';
import { KnowledgeChatService } from './knowledge-chat.service.js';

@Controller('knowledge-chat')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class KnowledgeChatController {
  constructor(private readonly chat: KnowledgeChatService) {}

  @Get('sessions')
  list() {
    return this.chat.listSessions();
  }

  @Post('sessions')
  create(@Body() dto: CreateSessionDto) {
    return this.chat.createSession(dto.prompt);
  }

  @Get('sessions/:id')
  detail(@Param('id') id: string) {
    return this.chat.getSession(id);
  }

  @Post('sessions/:id/runs')
  resume(@Param('id') id: string, @Body() dto: CreateRunDto) {
    return this.chat.resume(id, dto.prompt);
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
