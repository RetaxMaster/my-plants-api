import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { DoctorAllowed } from '../../auth/doctor-scope.decorator.js';
import { OwnerService } from '../../owner/owner.service.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ProposalsService, type DoctorTokenClaims } from './proposals.service.js';
import { createProposalSchema, type CreateProposalBody } from './proposal-operations.schema.js';

/** Empty body required — a non-empty body is a 400 (spec 5.5.1). */
const emptyBodySchema = z.object({}).strict();
const settingsSchema = z.object({ skipPermissions: z.boolean() }).strict();

/**
 * The owner-gated write-proposal surface. Two caller classes reach this controller and they are scoped
 * DIFFERENTLY, so every handler resolves which one it is talking to rather than sharing one lenient check.
 */
@Controller('plants/:id/diagnose/sessions/:sessionId')
export class ProposalsController {
  constructor(
    private readonly proposals: ProposalsService,
    private readonly owner: OwnerService,
  ) {}

  /**
   * The ONLY doctor-reachable write. `@DoctorAllowed()` alone would still admit an ordinary owner/ADMIN
   * session token — it only governs what a DOCTOR token may reach, it does not require one — so this
   * handler additionally asserts `scope === 'doctor'` (spec 5.5.1).
   */
  @Post('proposals')
  @DoctorAllowed()
  create(
    @Param('id') plantId: string,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(createProposalSchema)) body: CreateProposalBody,
  ) {
    const token = this.requireDoctorToken();
    if (plantId !== token.plantId || sessionId !== token.sessionId) {
      throw new ForbiddenException('path does not match the token');
    }
    return this.proposals.create(token, body);
  }

  @Get('proposals/pending')
  getPending(@Param('id') plantId: string, @Param('sessionId') sessionId: string) {
    this.rejectDoctorToken();
    return this.proposals.getPending(plantId, sessionId);
  }

  @Post('proposals/:proposalId/approve')
  @HttpCode(200)
  approve(
    @Param('id') plantId: string,
    @Param('sessionId') sessionId: string,
    @Param('proposalId') proposalId: string,
    @Body(new ZodValidationPipe(emptyBodySchema)) _body: unknown,
  ) {
    this.rejectDoctorToken();
    return this.proposals.approve(plantId, sessionId, proposalId);
  }

  @Post('proposals/:proposalId/decline')
  @HttpCode(200)
  decline(
    @Param('id') plantId: string,
    @Param('sessionId') sessionId: string,
    @Param('proposalId') proposalId: string,
    @Body(new ZodValidationPipe(emptyBodySchema)) _body: unknown,
  ) {
    this.rejectDoctorToken();
    return this.proposals.decline(plantId, sessionId, proposalId);
  }

  /** Readable by the effective owner AND by a doctor token (spec 5.5.1). */
  @Get('settings')
  @DoctorAllowed()
  getSettings(@Param('id') plantId: string, @Param('sessionId') sessionId: string) {
    // Same route, two caller classes. The scope check differs per class, so resolve which one this is HERE
    // and let the service enforce the matching rule — never a single lenient check that satisfies neither.
    const actor = this.owner.currentActor();
    const caller =
      actor?.scope === 'doctor'
        ? ({ kind: 'doctor', token: this.requireDoctorToken() } as const)
        : ({ kind: 'owner' } as const);
    return this.proposals.getSettings(plantId, sessionId, caller);
  }

  /**
   * Effective owner ONLY. No `@DoctorAllowed()`: an agent that could disable its own supervision is not
   * supervised. The global DoctorScopeGuard default-denies it, and `rejectDoctorToken` is the second line
   * of defence behind that.
   */
  @Patch('settings')
  setSettings(
    @Param('id') plantId: string,
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(settingsSchema)) body: { skipPermissions: boolean },
  ) {
    this.rejectDoctorToken();
    return this.proposals.setSkipPermissions(plantId, sessionId, body.skipPermissions);
  }

  /**
   * A doctor token, fully unpacked. Every claim is required: a token missing `sessionId` or `runId` is a
   * PRE-SEAL token (minted before the proposal feature sealed them on), and treating it as valid would let
   * it file a proposal against a session it was never pinned to.
   */
  private requireDoctorToken(): DoctorTokenClaims {
    const actor = this.owner.currentActor();
    if (!actor || actor.scope !== 'doctor' || !actor.sessionId || !actor.runId || !actor.plantId) {
      throw new ForbiddenException('a doctor-scoped token is required');
    }
    return {
      userId: actor.userId,
      plantId: actor.plantId,
      ownerId: actor.ownerId,
      sessionId: actor.sessionId,
      runId: actor.runId,
    };
  }

  private rejectDoctorToken(): void {
    if (this.owner.currentActor()?.scope === 'doctor') {
      throw new ForbiddenException('not permitted for a doctor-scoped token');
    }
  }
}
