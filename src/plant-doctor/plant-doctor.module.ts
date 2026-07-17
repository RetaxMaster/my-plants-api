import { Module } from '@nestjs/common';
import { KnowledgeChatModule } from '../knowledge-chat/knowledge-chat.module.js';
import { PlantDoctorController } from './plant-doctor.controller.js';
import { DoctorSessionCleanupService } from './doctor-session-cleanup.service.js';

// The owner-scoped Plant Doctor surface. It sits OVER the shared KnowledgeChatModule (reuse-not-fork): the
// controller obtains KnowledgeChatService, the DOCTOR engine, and CodexRoleVerificationService via that
// import; PrismaService + OwnerService are global. DoctorRunContextService is provided+exported by
// KnowledgeChatModule (the module-placement fix, Spec 3 §3.3) — NOT re-provided here, or we'd get two
// instances. DoctorSessionCleanupService is the orchestrated plant-delete purge (Spec 3 §3.1), exported for
// a future plant-delete flow to call.
@Module({
  imports: [KnowledgeChatModule],
  controllers: [PlantDoctorController],
  providers: [DoctorSessionCleanupService],
  exports: [DoctorSessionCleanupService],
})
export class PlantDoctorModule {}
