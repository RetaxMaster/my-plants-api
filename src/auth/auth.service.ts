import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export interface JwtPayload {
  sub: string;
  username: string;
  ownerId: string;
  role: 'USER' | 'ADMIN';
  jti: string;
  // Session-start anchor (epoch seconds), set at first login and preserved across refreshes.
  // Absent on legacy tokens minted before this feature — verify() falls back to iat for those.
  sst?: number;
  // Plant Doctor scoped token (Spec 3 §3.3): `scope:'doctor'` + `plantId` NARROW an otherwise-normal
  // owner token to a five-endpoint allowlist pinned to that one plant. Absent on every ordinary token.
  scope?: 'doctor';
  plantId?: string;
  // Present ONLY on a `scope:'doctor'` token: the chat session and the single run it was minted for.
  // The proposal endpoints seal a write proposal to both, so a token cannot act outside its own run.
  sessionId?: string;
  runId?: string;
  iat: number;
  exp: number;
}

// Pure, dependency-free cap check so the age math is unit-testable without minting/backdating JWTs.
// All args in epoch SECONDS except maxDays. anchor = the session-start time (sst, or iat for legacy).
export function sessionAgeExceeded(anchorSec: number, nowSec: number, maxDays: number): boolean {
  return nowSec - anchorSec > maxDays * 86400;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async login(
    username: string,
    password: string,
  ): Promise<{ token: string; user: { username: string; ownerId: string; role: 'USER' | 'ADMIN' } }> {
    const user = await this.prisma.user.findUnique({ where: { username } });
    const ok = user && (await bcrypt.compare(password, user.passwordHash));
    if (!user || !ok) throw new UnauthorizedException('Invalid credentials'); // generic — no user enumeration
    await this.purgeExpired();
    const token = await this.jwt.signAsync({
      sub: user.id,
      username: user.username,
      ownerId: user.ownerId,
      role: user.role,
      jti: randomUUID(),
      sst: Math.floor(Date.now() / 1000),
    });
    return { token, user: { username: user.username, ownerId: user.ownerId, role: user.role } };
  }

  // Mint a fresh 30-day token for an already-authenticated actor, preserving the session-start
  // anchor so the absolute cap keeps counting from the FIRST login. Revokes the old jti (idempotent)
  // to shrink the window where two tokens are valid. Refuses past the absolute cap (defensive — the
  // guard's verify() already rejects such a token before this runs).
  async refresh(actor: {
    userId: string;
    username: string;
    ownerId: string;
    role: 'USER' | 'ADMIN';
    jti: string;
    sst: number;
    exp: number;
  }): Promise<{ token: string }> {
    if (sessionAgeExceeded(actor.sst, Math.floor(Date.now() / 1000), this.env.SESSION_ABSOLUTE_MAX_DAYS)) {
      throw new UnauthorizedException('Session expired');
    }
    const token = await this.jwt.signAsync({
      sub: actor.userId,
      username: actor.username,
      ownerId: actor.ownerId,
      role: actor.role,
      jti: randomUUID(),
      sst: actor.sst,
    });
    await this.logout(actor.jti, actor.exp); // revoke the superseded token
    return { token };
  }

  // A per-run token scoped to ONE plant (Spec 3 §3.3). It carries a FULL, self-consistent payload so the
  // normal pipeline (verify → jti revocation → JwtAuthGuard → Actor) builds a valid actor; `scope:'doctor'`
  // + `plantId` NARROW it (the DoctorScopeGuard default-denies it everywhere but a five-endpoint allowlist
  // pinned to that plant). role is ALWAYS USER — a doctor token is never an admin token. TTL is short
  // (PLANT_DOCTOR_TOKEN_TTL_MS), covering one run. `sst` is set so verify()'s absolute-cap math has an
  // anchor (a fresh token is well within the cap).
  async mintDoctorToken(input: {
    userId: string;
    username: string;
    ownerId: string;
    plantId: string;
    sessionId: string;
    runId: string;
  }): Promise<string> {
    const ttlSeconds = Math.floor(this.env.PLANT_DOCTOR_TOKEN_TTL_MS / 1000);
    return this.jwt.signAsync(
      {
        sub: input.userId,
        username: input.username,
        ownerId: input.ownerId,
        role: 'USER' as const,
        jti: randomUUID(),
        sst: Math.floor(Date.now() / 1000),
        scope: 'doctor' as const,
        plantId: input.plantId,
        // Seals the token to ONE run of ONE session. Without this a doctor token could file a proposal
        // against a DIFFERENT session of the same plant — and that session might have Skip Permissions
        // on, so the proposal would be auto-applied with no human ever seeing it.
        sessionId: input.sessionId,
        runId: input.runId,
      },
      { expiresIn: ttlSeconds }, // per-call override of the module's 30d default
    );
  }

  async verify(token: string): Promise<JwtPayload> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
    const revoked = await this.prisma.revokedToken.findUnique({ where: { jti: payload.jti } });
    if (revoked) throw new UnauthorizedException('Token revoked');
    const anchor = payload.sst ?? payload.iat;
    if (sessionAgeExceeded(anchor, Math.floor(Date.now() / 1000), this.env.SESSION_ABSOLUTE_MAX_DAYS)) {
      throw new UnauthorizedException('Session expired');
    }
    return payload;
  }

  // Cheap PK existence check used by the guard before honoring an X-Act-As-Owner header, so a bogus
  // target fails early with a controlled 403 instead of a Prisma FK error / 500 on the next write.
  async ownerExists(id: string): Promise<boolean> {
    const owner = await this.prisma.owner.findUnique({ where: { id }, select: { id: true } });
    return owner !== null;
  }

  async logout(jti: string, exp: number): Promise<void> {
    // exp is seconds-since-epoch from the JWT; bind a native Date (MariaDB date rule).
    try {
      await this.prisma.revokedToken.create({ data: { jti, expiresAt: new Date(exp * 1000) } });
    } catch (err) {
      // Idempotent ONLY for a duplicate jti (already revoked). Any other failure is real and must
      // surface — refresh() depends on this revocation actually happening.
      if ((err as { code?: string })?.code !== 'P2002') throw err;
    }
  }

  async purgeExpired(): Promise<void> {
    await this.prisma.revokedToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }
}
