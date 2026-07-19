import { Module } from '@nestjs/common';
import { KnowledgeChatModule } from '../knowledge-chat/knowledge-chat.module.js';
import { CarePlanModule } from '../care-plan/care-plan.module.js';
import { ImageUploadModule } from '../storage/image-upload.module.js';
import { PhotoInboxModule } from '../storage/photo-inbox.module.js';
import { PhotoWorkerModule } from '../photo-worker/photo-worker.module.js';
import { PlantDoctorController } from './plant-doctor.controller.js';
import { DoctorSessionCleanupService } from './doctor-session-cleanup.service.js';
import { ProposalsController } from './proposals/proposals.controller.js';
import { ProposalsService } from './proposals/proposals.service.js';
import { ProposalApplierService } from './proposals/proposal-applier.service.js';
import { ProposalSnapshotService } from './proposals/proposal-snapshot.service.js';
import { ProposalRenderService } from './proposals/proposal-render.service.js';

// The owner-scoped Plant Doctor surface. It sits OVER the shared KnowledgeChatModule (reuse-not-fork): the
// controller obtains KnowledgeChatService, the DOCTOR engine, and CodexRoleVerificationService via that
// import; PrismaService + OwnerService are global. DoctorRunContextService is provided+exported by
// KnowledgeChatModule (the module-placement fix, Spec 3 §3.3) — NOT re-provided here, or we'd get two
// instances. DoctorSessionCleanupService is the orchestrated plant-delete purge (Spec 3 §3.1), exported for
// a future plant-delete flow to call.
// The proposal providers live here (not in KnowledgeChatModule) because the write-proposal flow is a
// Plant-Doctor concern; the applier's collaborators come from the four modules imported below, which is
// what keeps the module graph one-way (PlantDoctor -> KnowledgeChat, never back).
@Module({
  imports: [KnowledgeChatModule, CarePlanModule, ImageUploadModule, PhotoInboxModule, PhotoWorkerModule],
  controllers: [PlantDoctorController, ProposalsController],
  providers: [
    DoctorSessionCleanupService,
    ProposalsService,
    ProposalApplierService,
    ProposalSnapshotService,
    ProposalRenderService,
  ],
  exports: [DoctorSessionCleanupService],
})
export class PlantDoctorModule {}
