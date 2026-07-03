import { Module } from '@nestjs/common';
import { KnowledgeChatTicketService } from './engine/knowledge-chat-ticket.service.js';
import { KnowledgeChatOrchestrator } from './engine/knowledge-chat-orchestrator.js';
import { KnowledgeChatEngineService } from './engine/knowledge-chat-engine.service.js';

// The admin knowledge-engine chat module. This phase wires the embedded engine + its Prisma seams;
// Phase 4 adds the controller + chat service to `controllers`/`providers`.
@Module({
  providers: [KnowledgeChatTicketService, KnowledgeChatOrchestrator, KnowledgeChatEngineService],
  exports: [KnowledgeChatTicketService, KnowledgeChatEngineService],
})
export class KnowledgeChatModule {}
