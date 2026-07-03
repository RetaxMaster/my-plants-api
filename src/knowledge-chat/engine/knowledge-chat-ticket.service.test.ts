import { describe, expect, it, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { KnowledgeChatTicketService } from './knowledge-chat-ticket.service.js';

interface Row { id: string; runId: string; tokenHash: string; expiresAt: Date; consumedAt: Date | null }

function makePrismaFake() {
  const rows = new Map<string, Row>(); // keyed by tokenHash
  return {
    rows,
    knowledgeChatTicket: {
      create: async ({ data }: any) => {
        const row: Row = { id: `t${rows.size + 1}`, consumedAt: null, ...data };
        rows.set(data.tokenHash, row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const row = rows.get(where.tokenHash);
        const now: Date = where.expiresAt.gt;
        if (!row || row.consumedAt !== null || row.expiresAt <= now) return { count: 0 };
        row.consumedAt = data.consumedAt;
        return { count: 1 };
      },
      findUnique: async ({ where }: any) => rows.get(where.tokenHash) ?? null,
    },
  };
}

const env = { KNOWLEDGE_CHAT_TICKET_TTL_MS: 60_000 } as any;

describe('KnowledgeChatTicketService', () => {
  let prisma: ReturnType<typeof makePrismaFake>;
  let svc: KnowledgeChatTicketService;
  beforeEach(() => {
    prisma = makePrismaFake();
    svc = new KnowledgeChatTicketService(prisma as any, env);
  });

  it('mint stores only the sha256 hash and returns the raw token once', async () => {
    const raw = await svc.mint('run-1');
    expect(raw).toBeTruthy();
    const stored = [...prisma.rows.values()][0];
    expect(stored.tokenHash).toBe(createHash('sha256').update(raw).digest('hex'));
    expect((stored as any).token).toBeUndefined(); // raw is never persisted
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('consume returns the runId exactly once (single-use)', async () => {
    const raw = await svc.mint('run-42');
    expect(await svc.consume(raw)).toEqual({ runId: 'run-42' });
    expect(await svc.consume(raw)).toBeNull(); // already consumed
  });

  it('consume returns null for an unknown token', async () => {
    expect(await svc.consume('nope')).toBeNull();
  });

  it('consume returns null for an expired ticket', async () => {
    const shortEnv = { KNOWLEDGE_CHAT_TICKET_TTL_MS: -1 } as any; // already expired on mint
    const s = new KnowledgeChatTicketService(prisma as any, shortEnv);
    const raw = await s.mint('run-9');
    expect(await s.consume(raw)).toBeNull();
  });
});
