import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';

const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');

// Single-use socket tickets. We store ONLY sha256(raw); the raw token is returned once (to the
// browser) and never persisted, so a DB leak can't be replayed. `consume` is an atomic single-use
// claim: an unconsumed, unexpired row is marked consumed in one write; 0 rows affected → reject.
@Injectable()
export class KnowledgeChatTicketService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async mint(runId: string): Promise<string> {
    const raw = randomBytes(48).toString('base64url'); // ~64 chars, url-safe
    // Bind a NATIVE Date (MariaDB date rule) — never toISOString().
    const expiresAt = new Date(Date.now() + this.env.KNOWLEDGE_CHAT_TICKET_TTL_MS);
    await this.prisma.knowledgeChatTicket.create({
      data: { runId, tokenHash: sha256(raw), expiresAt },
    });
    return raw;
  }

  async consume(raw: string): Promise<{ runId: string } | null> {
    const tokenHash = sha256(raw);
    const now = new Date();
    // Atomic single-use claim: only an unconsumed, unexpired ticket transitions. Concurrent joins
    // race on this one write — exactly one wins (count === 1), the rest get 0.
    const { count } = await this.prisma.knowledgeChatTicket.updateMany({
      where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (count === 0) return null;
    const ticket = await this.prisma.knowledgeChatTicket.findUnique({ where: { tokenHash } });
    return ticket ? { runId: ticket.runId } : null;
  }
}
