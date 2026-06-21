import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

export interface JwtPayload {
  sub: string;
  username: string;
  ownerId: string;
  role: 'USER' | 'ADMIN';
  jti: string;
  iat: number;
  exp: number;
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService) {}

  async login(
    username: string,
    password: string,
  ): Promise<{ token: string; user: { username: string; role: 'USER' | 'ADMIN' } }> {
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
    });
    return { token, user: { username: user.username, role: user.role } };
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
    return payload;
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
