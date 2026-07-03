import { Module } from '@nestjs/common';
import { RolesGuard } from '../auth/roles.guard.js';
import { KnowledgeChatTicketService } from './engine/knowledge-chat-ticket.service.js';
import { KnowledgeChatOrchestrator } from './engine/knowledge-chat-orchestrator.js';
import { KnowledgeChatEngineService } from './engine/knowledge-chat-engine.service.js';
import { KnowledgeChatController } from './knowledge-chat.controller.js';
import { KnowledgeChatService } from './knowledge-chat.service.js';

// The admin knowledge-engine chat module: the embedded engine + its Prisma seams, plus the admin
// HTTP surface. RolesGuard is a provider here so @UseGuards(RolesGuard) can resolve it via DI (it
// injects Reflector from core + OwnerService from the global OwnerModule).
@Module({
  controllers: [KnowledgeChatController],
  providers: [
    KnowledgeChatTicketService,
    KnowledgeChatOrchestrator,
    KnowledgeChatEngineService,
    KnowledgeChatService,
    RolesGuard,
  ],
  exports: [KnowledgeChatTicketService, KnowledgeChatEngineService],
})
export class KnowledgeChatModule {}
