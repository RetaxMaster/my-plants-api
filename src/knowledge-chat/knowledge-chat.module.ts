import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { KnowledgeChatTicketService } from './engine/knowledge-chat-ticket.service.js';
import { KnowledgeChatOrchestrator } from './engine/knowledge-chat-orchestrator.js';
import { KnowledgeChatEngineService } from './engine/knowledge-chat-engine.service.js';
import { ChatEngineRegistry } from './engine/chat-engine-registry.js';
import {
  DOCTOR_ENGINE,
  DOCTOR_ORCHESTRATOR,
  KNOWLEDGE_ENGINE,
  KNOWLEDGE_ORCHESTRATOR,
  doctorEngineParams,
  knowledgeEngineParams,
} from './engine/engine-params.js';
import { KnowledgeChatController } from './knowledge-chat.controller.js';
import { KnowledgeChatService } from './knowledge-chat.service.js';
import { CodexRoleVerificationService } from './codex-role-verification.service.js';
import { DoctorRunContextService } from '../plant-doctor/doctor-run-context.service.js';

// The shared chat machinery: the embedded engine + its Prisma seams, plus the admin KE HTTP surface. Since
// the Plant Doctor (Spec 3 §2) it stands up TWO engine + TWO orchestrator instances from the SAME classes,
// keyed by ChatSessionKind, behind the ChatEngineRegistry — one service, one orchestrator impl, one engine
// impl, instantiated per engine (reuse-not-fork). RolesGuard is a provider so @UseGuards(RolesGuard) can
// resolve it. DoctorRunContextService + CodexRoleVerificationService live HERE (not in PlantDoctorModule)
// because KnowledgeChatService injects them and Nest resolves a provider against the DEFINING module's own
// providers + imports, never against a downstream importer (Spec 3 §3.3 module-placement fix). AuthModule
// is imported for AuthService (the scoped-token mint).
@Module({
  imports: [AuthModule],
  controllers: [KnowledgeChatController],
  providers: [
    KnowledgeChatTicketService,
    {
      provide: KNOWLEDGE_ORCHESTRATOR,
      useFactory: (p: PrismaService, t: KnowledgeChatTicketService, env: Env) =>
        new KnowledgeChatOrchestrator(knowledgeEngineParams(env), p, t),
      inject: [PrismaService, KnowledgeChatTicketService, ENV],
    },
    {
      provide: DOCTOR_ORCHESTRATOR,
      useFactory: (p: PrismaService, t: KnowledgeChatTicketService, env: Env) =>
        new KnowledgeChatOrchestrator(doctorEngineParams(env), p, t),
      inject: [PrismaService, KnowledgeChatTicketService, ENV],
    },
    {
      provide: KNOWLEDGE_ENGINE,
      useFactory: (env: Env, orch: KnowledgeChatOrchestrator) =>
        new KnowledgeChatEngineService(knowledgeEngineParams(env), env, orch),
      inject: [ENV, KNOWLEDGE_ORCHESTRATOR],
    },
    {
      provide: DOCTOR_ENGINE,
      useFactory: (env: Env, orch: KnowledgeChatOrchestrator) =>
        new KnowledgeChatEngineService(doctorEngineParams(env), env, orch),
      inject: [ENV, DOCTOR_ORCHESTRATOR],
    },
    ChatEngineRegistry,
    CodexRoleVerificationService,
    DoctorRunContextService,
    KnowledgeChatService,
    RolesGuard,
  ],
  exports: [
    KnowledgeChatTicketService,
    KNOWLEDGE_ENGINE,
    DOCTOR_ENGINE,
    ChatEngineRegistry,
    KnowledgeChatService,
    CodexRoleVerificationService,
    DoctorRunContextService,
  ],
})
export class KnowledgeChatModule {}
