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
    } catch {
      /* already revoked — idempotent */
    }
  }

  async purgeExpired(): Promise<void> {
    await this.prisma.revokedToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }
}
