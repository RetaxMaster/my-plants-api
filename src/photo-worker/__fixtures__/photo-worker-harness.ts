// A real, executable in-memory harness for PhotoWorkerService (SHOULD-FIX 1 — no vacuous tests). It fakes the
// three collaborators and models REAL state so tests assert tokens / statuses / attempts / affected-row
// semantics for real:
//   • DB  — a Map<id, PhotoRow> + a tiny $queryRaw/$executeRaw interpreter that understands the worker's
//           handful of raw statements and returns the ACTUAL affected-row count by applying each WHERE guard
//           (id + token + status + NOW()/INTERVAL eligibility) against an injectable clock.
//   • inbox — a Map<path, Buffer>; delete/deleteMany/exists mutate/read it.
//   • R2   — a Set<objectKey> of live objects; upload adds a key, confirmDelete/delete remove it (or throw
//           when an outage is armed).
import { PhotoWorkerService } from '../photo-worker.service.js';

export interface PhotoRow {
  id: string;
  entryId: string;
  plantId: string;
  status: 'PENDING' | 'PROCESSING' | 'RECOVERING' | 'READY' | 'FAILED';
  imageUrl: string | null;
  imageObjectKey: string | null;
  inboxPath: string | null;
  originalName: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  claimToken: string | null;
  claimedAt: Date | null;
  failureKind: 'transient' | 'permanent' | null;
  failureCode: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

// Render a Prisma tagged-template (strings + interpolated values) into a canonical SQL string + ordered scalar
// params. A Prisma.Sql interpolation (Prisma.raw(...)) is INLINED into the text (never a bound param) — exactly
// how the real driver treats it — so the worker's `INTERVAL ${Prisma.raw(String(n))} SECOND` reads back from
// the SQL. Everything else is a scalar bound param captured in order.
interface SqlLike { strings: string[]; values: unknown[] }
// Prisma.Sql (from Prisma.raw/Prisma.sql) is a TYPE-only export here (Prisma.Sql is undefined at runtime in
// this client version), so detect it structurally: it carries `strings` + `values` arrays.
function isSql(v: unknown): v is SqlLike {
  return !!v && typeof v === 'object' && Array.isArray((v as SqlLike).strings) && Array.isArray((v as SqlLike).values);
}
function render(strings: TemplateStringsArray | readonly string[], values: unknown[]): { sql: string; params: unknown[] } {
  let sql = strings[0];
  const params: unknown[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isSql(v)) {
      // Prisma.raw('30') → strings ['30'], values []. Inline its text verbatim.
      sql += renderSql(v);
    } else {
      params.push(v);
      sql += '?';
    }
    sql += strings[i + 1];
  }
  return { sql: sql.replace(/\s+/g, ' ').trim(), params };
}
function renderSql(s: SqlLike): string {
  let out = s.strings[0];
  for (let i = 0; i < s.values.length; i++) {
    const v = s.values[i];
    out += isSql(v) ? renderSql(v) : String(v);
    out += s.strings[i + 1];
  }
  return out;
}

const intervalMs = (sql: string): number => {
  const m = sql.match(/INTERVAL (\d+) (SECOND|DAY)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2].toUpperCase() === 'DAY' ? n * 86_400_000 : n * 1000;
};

interface R2Hooks { onUpload?: () => Promise<void> }

export function makeHarness() {
  const db = new Map<string, PhotoRow>();
  const inbox = new Map<string, Buffer>();
  const r2 = new Set<string>();
  const events: string[] = [];
  const clock = { ms: Date.UTC(2026, 6, 14, 12, 0, 0), now(): number { return this.ms; }, advanceSeconds(s: number) { this.ms += s * 1000; } };
  const nowDate = () => new Date(clock.ms);

  let seq = 0;
  const nextId = (p: string) => `${p}${++seq}`;
  let lastClaimToken: string | null = null;
  let beforeCommit: (() => void) | null = null;

  // ---- fake R2 ------------------------------------------------------------------------------------------
  const r2hooks: R2Hooks = {};
  let uploadError: Error | null = null;
  let uploadHang = false;
  let failConfirmDelete = 0;
  const confirmDeleteCalls: string[] = [];
  const deleteCalls: string[] = [];
  let settledBeforeRecord = false;

  const images = {
    async upload(input: { buffer: Buffer; key: string; signal?: AbortSignal }) {
      if (r2hooks.onUpload) await r2hooks.onUpload();
      if (uploadHang) {
        // Resolve/reject only when the AbortSignal fires (models a hung PUT the per-photo timeout cancels).
        await new Promise<void>((_resolve, reject) => {
          const abort = () => { settledBeforeRecord = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
          if (input.signal?.aborted) return abort();
          input.signal?.addEventListener('abort', abort);
        });
      }
      if (uploadError) { settledBeforeRecord = true; throw uploadError; }
      settledBeforeRecord = true;
      r2.add(input.key);
      return { imageUrl: `https://cdn/${input.key}`, imageObjectKey: input.key, sizeBytes: input.buffer.length, width: 1, height: 1 };
    },
    async delete(key: string | null | undefined) { if (!key) return; deleteCalls.push(key); r2.delete(key); },
    async confirmDelete(key: string) {
      confirmDeleteCalls.push(key);
      if (failConfirmDelete > 0) { failConfirmDelete -= 1; throw Object.assign(new Error('R2 down'), { $metadata: { httpStatusCode: 503 } }); }
      r2.delete(key); events.push(`confirmDelete:${key}`);
    },
  };

  // ---- fake inbox ---------------------------------------------------------------------------------------
  const inboxSvc = {
    async read(path: string) {
      const buf = inbox.get(path);
      if (!buf) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }); // removed/never-staged bytes
      return buf;
    },
    async delete(path: string | null | undefined) { if (path) inbox.delete(path); },
    async deleteMany(paths: (string | null | undefined)[]) { for (const p of paths) if (p) inbox.delete(p); },
    async exists(path: string | null | undefined) { return !!path && inbox.has(path); },
    async sweepOrphans() { return [] as string[]; },
  };

  // ---- fake DB (raw-SQL interpreter) --------------------------------------------------------------------
  const eligiblePending = (r: PhotoRow) =>
    r.status === 'PENDING' && (r.nextAttemptAt === null || r.nextAttemptAt.getTime() <= clock.now());

  const queryRaw = async (strings: TemplateStringsArray | readonly string[], ...values: unknown[]) => {
    const { sql } = render(strings, values);
    if (/SELECT p\.id FROM plant_progress_photos/i.test(sql)) {
      // (A) claim candidates: eligible PENDING, created_at asc, limit 10
      return [...db.values()].filter(eligiblePending)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, 10).map((r) => ({ id: r.id }));
    }
    if (/SELECT ph\.id, ph\.claim_token, e\.plant_id/i.test(sql)) {
      // (B) stale claims: token set AND (PROCESSING older than stale window OR RECOVERING)
      const staleMs = intervalMs(sql);
      return [...db.values()].filter((r) =>
        r.claimToken !== null && (
          (r.status === 'PROCESSING' && r.claimedAt !== null && r.claimedAt.getTime() < clock.now() - staleMs)
          || r.status === 'RECOVERING'),
      ).map((r) => ({ id: r.id, claim_token: r.claimToken, plant_id: r.plantId }));
    }
    if (/SELECT id, inbox_path FROM plant_progress_photos/i.test(sql)) {
      // (C) inbox TTL: FAILED, inbox_path set, updated_at older than TTL
      const ttlMs = intervalMs(sql);
      return [...db.values()].filter((r) =>
        r.status === 'FAILED' && r.inboxPath !== null && r.updatedAt.getTime() < clock.now() - ttlMs,
      ).map((r) => ({ id: r.id, inbox_path: r.inboxPath }));
    }
    throw new Error(`fake queryRaw: unrecognized SQL: ${sql}`);
  };

  const executeRaw = async (strings: TemplateStringsArray | readonly string[], ...values: unknown[]) => {
    const { sql, params } = render(strings, values);
    // (D) claim: SET status='PROCESSING' ... params [token, id]
    if (/SET status = 'PROCESSING'/i.test(sql)) {
      const [token, id] = params as [string, string];
      const r = db.get(id);
      if (r && eligiblePending(r)) { r.status = 'PROCESSING'; r.claimToken = token; r.claimedAt = nowDate(); r.updatedAt = nowDate(); lastClaimToken = token; return 1; }
      return 0;
    }
    // (E) commit READY ... params [imageUrl, imageObjectKey, id, claimToken]
    if (/SET status = 'READY'/i.test(sql)) {
      if (beforeCommit) { beforeCommit(); beforeCommit = null; }
      const [imageUrl, imageObjectKey, id, token] = params as [string, string, string, string];
      const r = db.get(id);
      if (r && r.claimToken === token && r.status === 'PROCESSING') {
        r.status = 'READY'; r.imageUrl = imageUrl; r.imageObjectKey = imageObjectKey; r.inboxPath = null; r.claimToken = null; r.updatedAt = nowDate();
        events.push(`update:${id}:READY`); return 1;
      }
      return 0;
    }
    // (F) FAILED permanent ... params [code, id, token]
    if (/SET status='FAILED', failure_kind='permanent'/i.test(sql)) {
      const [code, id, token] = params as [string, string, string];
      const r = db.get(id);
      if (r && r.claimToken === token && r.status === 'PROCESSING') {
        r.status = 'FAILED'; r.failureKind = 'permanent'; r.failureCode = code; r.inboxPath = null; r.claimToken = null; r.updatedAt = nowDate();
        events.push(`update:${id}:FAILED`); return 1;
      }
      return 0;
    }
    // (G) FAILED transient exhausted ... params [code, attempts, id, token]
    if (/SET status='FAILED', failure_kind='transient'/i.test(sql)) {
      const [code, attempts, id, token] = params as [string, number, string, string];
      const r = db.get(id);
      if (r && r.claimToken === token && r.status === 'PROCESSING') {
        r.status = 'FAILED'; r.failureKind = 'transient'; r.failureCode = code; r.attempts = attempts; r.claimToken = null; r.updatedAt = nowDate();
        events.push(`update:${id}:FAILED`); return 1;
      }
      return 0;
    }
    // (H) reschedule PENDING with backoff ... params [attempts, id, token]; interval inlined in SQL
    if (/SET status='PENDING', attempts=/i.test(sql)) {
      const [attempts, id, token] = params as [number, string, string];
      const r = db.get(id);
      if (r && r.claimToken === token && r.status === 'PROCESSING') {
        r.status = 'PENDING'; r.attempts = attempts; r.claimToken = null;
        r.nextAttemptAt = new Date(clock.now() + intervalMs(sql)); r.updatedAt = nowDate();
        events.push(`update:${id}:PENDING`); return 1;
      }
      return 0;
    }
    // (I) recover take-over into RECOVERING (retain token) ... params [id, oldToken]; interval inlined
    if (/SET status='RECOVERING', claimed_at=NOW\(\)/i.test(sql)) {
      const staleMs = intervalMs(sql);
      const [id, token] = params as [string, string];
      const r = db.get(id);
      const eligible = r && r.claimToken === token && (
        (r.status === 'PROCESSING' && r.claimedAt !== null && r.claimedAt.getTime() < clock.now() - staleMs) || r.status === 'RECOVERING');
      if (eligible && r) { r.status = 'RECOVERING'; r.claimedAt = nowDate(); r.updatedAt = nowDate(); events.push(`update:${id}:RECOVERING`); return 1; }
      return 0;
    }
    // (J) recover release RECOVERING → PENDING ... params [id, oldToken]
    if (/SET status='PENDING', claim_token=NULL, claimed_at=NULL, next_attempt_at=NULL/i.test(sql)) {
      const [id, token] = params as [string, string];
      const r = db.get(id);
      if (r && r.status === 'RECOVERING' && r.claimToken === token) {
        r.status = 'PENDING'; r.claimToken = null; r.claimedAt = null; r.nextAttemptAt = null; r.updatedAt = nowDate();
        events.push(`update:${id}:PENDING`); return 1;
      }
      return 0;
    }
    // (K) inbox TTL guarded claim: SET inbox_path=NULL ... params [id, inboxPath]; interval inlined
    if (/SET inbox_path=NULL/i.test(sql)) {
      const ttlMs = intervalMs(sql);
      const [id, inboxPath] = params as [string, string];
      const r = db.get(id);
      if (r && r.status === 'FAILED' && r.inboxPath === inboxPath && r.updatedAt.getTime() < clock.now() - ttlMs) {
        r.inboxPath = null; r.updatedAt = nowDate(); return 1;
      }
      return 0;
    }
    throw new Error(`fake executeRaw: unrecognized SQL: ${sql}`);
  };

  const prisma = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    plantProgressPhoto: {
      async findUniqueOrThrow({ where }: { where: { id: string } }) {
        const r = db.get(where.id);
        if (!r) throw new Error(`row not found: ${where.id}`);
        return { ...r, entry: { plantId: r.plantId } };
      },
      async findMany({ where }: { where?: { inboxPath?: { not: null } } } = {}) {
        let rows = [...db.values()];
        if (where?.inboxPath?.not === null) rows = rows.filter((r) => r.inboxPath !== null);
        return rows.map((r) => ({ inboxPath: r.inboxPath }));
      },
    },
  };

  // Attach @internal test seams to a worker instance WITHOUT widening the real service's public API — the
  // seams just call the private drain/recover/sweep so the harness drives real code, not a mock of it.
  type Seamed = PhotoWorkerService & {
    drainOnce(): Promise<void>; enqueueTickAsync(): Promise<void>;
    recoverOnce(): Promise<void>; sweepOnce(): Promise<void>;
  };
  const makeWorker = (): Seamed => {
    const w = new PhotoWorkerService(prisma as never, inboxSvc as never, images as never);
    const priv = w as unknown as { drain(): Promise<void>; recoverStaleClaims(): Promise<void>; sweepInboxTtlAndOrphans(): Promise<void> };
    const seamed = w as Seamed;
    seamed.drainOnce = () => priv.drain();
    seamed.enqueueTickAsync = () => priv.drain();
    seamed.recoverOnce = () => priv.recoverStaleClaims();
    seamed.sweepOnce = () => priv.sweepInboxTtlAndOrphans();
    return seamed;
  };
  const worker = makeWorker();

  // ---- seeding ------------------------------------------------------------------------------------------
  function baseRow(overrides: Partial<PhotoRow>): PhotoRow {
    const id = overrides.id ?? nextId('ph');
    const plantId = overrides.plantId ?? 'plant-1';
    const inboxPath = overrides.inboxPath !== undefined ? overrides.inboxPath : `/inbox/${id}.bin`;
    const row: PhotoRow = {
      id, entryId: overrides.entryId ?? 'entry-1', plantId,
      status: 'PENDING', imageUrl: null, imageObjectKey: null, inboxPath,
      originalName: overrides.originalName ?? null, attempts: 0, nextAttemptAt: null,
      claimToken: null, claimedAt: null, failureKind: null, failureCode: null,
      sortOrder: 0, createdAt: nowDate(), updatedAt: nowDate(), ...overrides,
    };
    if (row.inboxPath) inbox.set(row.inboxPath, Buffer.from(`bytes-${id}`));
    db.set(id, row);
    return row;
  }

  return {
    worker,
    db: {
      get: (id: string) => db.get(id),
      values: () => db.values(),
      mutate: (id: string, patch: Partial<PhotoRow>) => { const r = db.get(id); if (r) Object.assign(r, patch); },
    },
    inbox: {
      has: (p: string) => inbox.has(p),
      remove: (p: string) => inbox.delete(p),
    },
    // Live getters (NOT Object.assign over the Set, which would snapshot a boolean like settledBeforeRecord
    // at build time). Proxies has/add/size to the underlying live Set.
    r2: {
      has: (k: string) => r2.has(k),
      add: (k: string) => r2.add(k),
      get size() { return r2.size; },
      onUpload: (fn: () => Promise<void>) => { r2hooks.onUpload = fn; },
      armUploadError: (err: Error) => { uploadError = err; },
      armUploadHang: () => { uploadHang = true; },
      failConfirmDeleteFor: (n: number) => { failConfirmDelete = n; },
      get confirmDeleteCalls() { return confirmDeleteCalls; },
      get deleteCalls() { return deleteCalls; },
      get settledBeforeRecord() { return settledBeforeRecord; },
    },
    events,
    clock,
    get lastClaimToken() { return lastClaimToken; },
    onBeforeCommit: (fn: () => void) => { beforeCommit = fn; },
    tick: async () => { await Promise.resolve(); await Promise.resolve(); },
    spawnSecondWorker: () => makeWorker(),
    // @internal test seams over the private drain/recover/sweep.
    seedPending: (opts: Partial<PhotoRow> = {}) => { const r = baseRow({ status: 'PENDING', ...opts }); return { id: r.id, plantId: r.plantId, inboxPath: r.inboxPath! }; },
    seedProcessing: (opts: { claimToken: string; claimedAtAgeSeconds: number } & Partial<PhotoRow>) => {
      const { claimToken, claimedAtAgeSeconds, ...rest } = opts;
      const r = baseRow({ status: 'PROCESSING', claimToken, claimedAt: new Date(clock.now() - claimedAtAgeSeconds * 1000), ...rest });
      return { id: r.id, plantId: r.plantId, inboxPath: r.inboxPath! };
    },
    seedFailedTransient: (opts: { updatedAtAgeDays: number; inboxPresent: boolean } & Partial<PhotoRow>) => {
      const { updatedAtAgeDays, inboxPresent, ...rest } = opts;
      const id = opts.id ?? nextId('ph');
      const inboxPath = inboxPresent ? `/inbox/${id}.bin` : null;
      const r = baseRow({ id, status: 'FAILED', failureKind: 'transient', failureCode: 'upload_failed', attempts: 3, inboxPath, updatedAt: new Date(clock.now() - updatedAtAgeDays * 86_400_000), ...rest });
      return { id: r.id, plantId: r.plantId, inboxPath: r.inboxPath! };
    },
  };
}
