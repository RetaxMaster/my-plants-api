// @vitest-environment node — real MariaDB, real interactive transactions.
//
// Every property in this file is settled by the DATABASE, not by application logic (spec §5.6): a
// null-exempt unique index, a conditional update's row count, and the isolation of two overlapping
// transactions. A faked prisma cannot produce a unique violation or a row lock, so it cannot distinguish
// a correct implementation from a find-then-insert — which is the exact anti-pattern §5.6 forbids.
//
// This file does NOT boot Nest (the unit vitest.config.ts has no swc plugin, so decorator metadata is
// dropped and DI breaks). Collaborators are constructed manually, mirroring
// progress.concurrency.int.test.ts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { ConflictException } from '@nestjs/common';
import '../../config/load-env-file.js';
import { loadDbEnv } from '../../config/env.js';
import { buildDatabaseUrl } from '../../config/database-url.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OwnerService } from '../../owner/owner.service.js';
import { ProposalsService } from './proposals.service.js';
import { ProposalSnapshotService } from './proposal-snapshot.service.js';
import { ProposalRenderService } from './proposal-render.service.js';
import { ProposalApplierService } from './proposal-applier.service.js';
import { admitRun } from '../../knowledge-chat/knowledge-chat.service.js';

const prisma = new PrismaService(buildDatabaseUrl(loadDbEnv()));
const cls = new ClsService(new AsyncLocalStorage());
const owner = new OwnerService(cls);

// Non-DB collaborators: the properties under test live entirely in the DB, so these stay inert.
const carePlan = { recomputePlant: async () => {} } as never;
const images = { delete: async () => {} } as never;
const inbox = { deleteMany: async () => {} } as never;
const worker = { enqueueTick() {} } as never;

let ownerId: string;
let userId: string;
let cityId: string;
let placeId: string;
let plantId: string;
let sessionId: string;

/**
 * The REAL service against the REAL PrismaClient. It returns its collaborators so a test can attach a
 * barrier to the genuine snapshot service — substituting a faked prisma here would defeat the entire
 * proposition, since the unique violation IS the thing under test.
 */
function makeProposalsService() {
  const snapshots = new ProposalSnapshotService(prisma);
  const render = new ProposalRenderService(prisma, snapshots);
  const applier = new ProposalApplierService(prisma, carePlan, images, inbox, worker);
  const chat = { startQueuedSystemTurn: vi.fn(async () => null) } as never;
  const svc = new ProposalsService(prisma, snapshots, render, applier, owner, chat);
  return { svc, snapshots, render, applier };
}

// approve()/decline() resolve the acting user through currentActor(); loadOwned()/assertOwnedSession()
// scope through currentOwnerId(). Both come from the ONE real actor in CLS.
const runAs = <T>(fn: () => Promise<T>) =>
  cls.run(async () => {
    cls.set('actor', { userId, username: 'int', ownerId, role: 'USER', jti: 'j', sst: 0, exp: 9e9 });
    return fn();
  });

const tokenFor = (runId: string) => ({ userId, plantId, ownerId, sessionId, runId }) as never;
const clearWater = { summary: 's', operations: [{ type: 'frequency.clear', task: 'WATER' }] } as never;
const setWater = (intervalDays = 5) =>
  ({ summary: 's', operations: [{ type: 'frequency.set', task: 'WATER', intervalDays }] }) as never;

/** Make the session IDLE: settle the run and release the active slot. */
async function settleRun(runId: string) {
  await prisma.knowledgeChatRun.updateMany({
    where: { id: runId },
    data: { status: 'SUCCEEDED', activeKey: null, finishedAt: new Date() },
  });
}

/** Seal the session so a new turn can be admitted (admitRun/launch need a providerSessionId). */
async function sealSession() {
  await prisma.knowledgeChatSession.update({
    where: { id: sessionId },
    data: { providerSessionId: `prov-int-${randomUUID()}`, provider: 'claude' },
  });
}

/** A live, non-terminal run holding the active slot — the state the propose endpoint requires. */
async function makeRun(): Promise<string> {
  const run = await prisma.knowledgeChatRun.create({
    data: { sessionId, provider: 'claude', prompt: 'why is it yellow?', status: 'RUNNING', activeKey: 'ACTIVE' },
  });
  return run.id;
}

beforeAll(async () => {
  await prisma.onModuleInit();
  const species = await prisma.species.findFirst({ select: { slug: true } });
  if (!species) throw new Error('no seeded species found — cannot run the proposal concurrency int test');

  ownerId = (await prisma.owner.create({ data: { name: `prop-int-${randomUUID()}` } })).id;
  userId = (await prisma.user.create({
    data: { username: `prop-int-${randomUUID()}`, passwordHash: 'x', role: 'USER', ownerId },
  })).id;
  cityId = (await prisma.city.create({
    data: { ownerId, name: 'Proposal City', latitude: 19.43, longitude: -99.13, timezone: 'America/Mexico_City', isPrimary: true },
  })).id;
  placeId = (await prisma.place.create({
    data: { ownerId, cityId, name: 'Proposal Room', indoor: true, lightType: 'BRIGHT_INDIRECT' },
  })).id;
  plantId = (await prisma.plant.create({
    data: { ownerId, placeId, speciesSlug: species.slug, acquiredOn: new Date(Date.UTC(2020, 0, 1)) },
  })).id;
}, 30_000);

beforeEach(async () => {
  const s = await prisma.knowledgeChatSession.create({
    data: { title: 'proposal concurrency', kind: 'DOCTOR', plantId, ownerId, provider: 'claude' },
  });
  sessionId = s.id;
});

afterEach(async () => {
  // Audit rows carry NO FK, so they never cascade — delete them explicitly or they accumulate.
  await prisma.plantWriteAudit.deleteMany({ where: { plantId } }).catch(() => {});
  await prisma.plantTaskFrequency.deleteMany({ where: { plantId } }).catch(() => {});
  await prisma.knowledgeChatSession.deleteMany({ where: { plantId } }).catch(() => {});
  vi.restoreAllMocks(); // the barrier spy must not leak into the next test
});

afterAll(async () => {
  await prisma.plantWriteAudit.deleteMany({ where: { plantId } }).catch(() => {});
  await prisma.plant.deleteMany({ where: { id: plantId } }).catch(() => {});
  await prisma.place.deleteMany({ where: { id: placeId } }).catch(() => {});
  await prisma.city.deleteMany({ where: { id: cityId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
  await prisma.owner.deleteMany({ where: { id: ownerId } }).catch(() => {});
  await prisma.onModuleDestroy();
}, 30_000);

const insertPending = (runId: string) =>
  prisma.doctorWriteProposal.create({
    data: {
      sessionId, runId, plantId, ownerId,
      operations: '[]', snapshot: '[]', summary: 's', status: 'PENDING', pendingKey: 'PENDING',
    },
  });

describe('proposal concurrency (real MariaDB)', () => {
  it('the unique index alone forbids a second pending row', async () => {
    // Proves the INDEX. Necessary, not sufficient — the service-level races below are what ship.
    const runId = await makeRun();
    await insertPending(runId);
    await expect(insertPending(runId)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows many terminal rows per session because pendingKey is NULL on them', async () => {
    const runId = await makeRun();
    const a = await insertPending(runId);
    await prisma.doctorWriteProposal.updateMany({ where: { id: a.id }, data: { status: 'DECLINED', pendingKey: null } });
    const b = await insertPending(runId);
    await prisma.doctorWriteProposal.updateMany({ where: { id: b.id }, data: { status: 'EXPIRED', pendingKey: null } });
    await expect(insertPending(runId)).resolves.toBeTruthy();
  });

  it('the conditional update alone lets exactly one of two concurrent claims win', async () => {
    const runId = await makeRun();
    const p = await insertPending(runId);
    const claim = () =>
      prisma.doctorWriteProposal.updateMany({
        where: { id: p.id, status: 'PENDING' },
        data: { status: 'APPROVED', pendingKey: null, resolvedAt: new Date() },
      });
    const [a, b] = await Promise.all([claim(), claim()]);
    expect(a.count + b.count).toBe(1);
  });

  it('never lets two TRULY CONCURRENT create calls leave two pending proposals', async () => {
    // Spec §5.6: propose runs "expire the current pending row, THEN insert the new one" in ONE
    // transaction. Two SEQUENTIAL raw inserts never exercise that sequence at all — they cannot
    // distinguish a correct implementation from a find-then-insert. Only overlapping calls through the
    // REAL service can.
    const runId = await makeRun();
    const { svc } = makeProposalsService();

    // Repeated, because the interleaving is NOT controllable and the two legal outcomes have very
    // different shapes. Measured against real MariaDB: ~19/20 runs genuinely overlap (the expire's
    // next-key locks deadlock and InnoDB kills one -> P2034), ~1/20 serialize on the connection pool
    // (the second transaction sees the first's committed row and legitimately EXPIRES it, so both
    // succeed). Asserting "exactly one fulfilled" — as the plan did — pins the common interleaving and
    // fails the legal one, i.e. it is flaky, and the flake would be blamed on the code.
    //
    // So assert what must hold under EVERY interleaving instead. It is the stronger statement anyway:
    // the return values are incidental, two PENDING rows would be the actual disaster.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const results = await Promise.allSettled([
        svc.create(tokenFor(runId), clearWater),
        svc.create(tokenFor(runId), clearWater),
      ]);

      // NEVER two pending rows — the invariant the null-exempt unique index exists to enforce.
      expect(await prisma.doctorWriteProposal.count({ where: { sessionId, status: 'PENDING' } })).toBe(1);
      // At least one caller must always get through; "both rejected" would be a stuck session.
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      // And a loser must be told in the CONTRACT's vocabulary. A raw PrismaClientKnownRequestError here
      // is a 500 to the agent instead of an actionable 409 — the defect this loop actually caught, since
      // the real driver raises P2034 (deadlock) far more often than the P2002 a fake would hand back.
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictException);
      }

      await prisma.doctorWriteProposal.deleteMany({ where: { sessionId } });
    }
  });

  it('a propose that expires an older pending proposal leaves exactly one PENDING and one EXPIRED', async () => {
    const runId = await makeRun();
    const { svc } = makeProposalsService();

    const first = await svc.create(tokenFor(runId), clearWater);
    const second = await svc.create(tokenFor(runId), clearWater);
    expect(second.id).not.toBe(first.id);

    const rows = await prisma.doctorWriteProposal.findMany({ where: { sessionId } });
    expect(rows.filter((r) => r.status === 'PENDING')).toHaveLength(1);
    expect(rows.find((r) => r.id === first.id)!.status).toBe('EXPIRED');
    // pendingKey MUST be nulled on the expired row, or the index blocks all future proposals.
    expect(rows.find((r) => r.id === first.id)!.pendingKey).toBeNull();
  });

  it('never auto-applies on a REVOKED skip-permissions setting (read at apply time)', async () => {
    // Spec §6.4. A bare Promise.all here would be NON-DETERMINISTIC: both PENDING and APPROVED would be
    // legal, so the test could not fail when the bug (reading the stale top-of-method `session`) is
    // present. The ordering is forced with a barrier — revoke FIRST, then let the apply-time re-read
    // happen. With the fix the re-read observes `false` and the proposal stays PENDING; with the bug the
    // stale read observes `true` and it lands APPROVED.
    const runId = await makeRun();
    const { svc, snapshots } = makeProposalsService();
    await prisma.knowledgeChatSession.update({ where: { id: sessionId }, data: { skipPermissions: true } });

    const original = snapshots.capture.bind(snapshots);
    vi.spyOn(snapshots, 'capture').mockImplementation(async (pid, oid, ops) => {
      await prisma.knowledgeChatSession.update({ where: { id: sessionId }, data: { skipPermissions: false } });
      return original(pid, oid, ops);
    });

    const proposal = await svc.create(tokenFor(runId), setWater());

    expect(proposal.status).toBe('PENDING');
    expect(proposal.autoApproved).toBe(false);
    // And nothing was written to the plant.
    expect(await prisma.plantTaskFrequency.count({ where: { plantId } })).toBe(0);
  });

  it('lets exactly one of two concurrent approve calls apply — and writes ONCE', async () => {
    // Spec §10. A raw updateMany race proves the index; it does NOT prove the applier is safe, because
    // the applier also performs the DOMAIN WRITES. A double-apply that both succeeded would be invisible
    // to the raw test and catastrophic here (two writes, two audit rows).
    const runId = await makeRun();
    const { svc } = makeProposalsService();
    const created = await svc.create(tokenFor(runId), setWater());

    const results = await runAs(() =>
      Promise.allSettled([
        svc.approve(plantId, sessionId, created.id),
        svc.approve(plantId, sessionId, created.id),
      ]),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);

    // The invariants that actually matter: one row, one apply, one audit entry.
    const row = await prisma.doctorWriteProposal.findUnique({ where: { id: created.id } });
    expect(row!.status).toBe('APPROVED');
    expect(await prisma.plantTaskFrequency.count({ where: { plantId, task: 'WATER' } })).toBe(1);
    expect(await prisma.plantWriteAudit.count({ where: { proposalId: created.id } })).toBe(1);
  });

  it('an approve racing a new prompt turn resolves to exactly one of {APPROVED, EXPIRED}', async () => {
    // Spec §5.5.4 / §10: the admission transaction SHARES the active-slot transaction precisely so an
    // approve cannot land AFTER the run was admitted but BEFORE the expiry. Both outcomes are legal; what
    // is forbidden is both, or neither, or an approve that applies to an already-expired proposal.
    const runId = await makeRun();
    const { svc } = makeProposalsService();
    const created = await svc.create(tokenFor(runId), setWater());

    // The session must be IDLE before racing, or this proves nothing: the run that FILED the proposal is
    // non-terminal by construction and still holds `activeKey`, so admitRun would simply lose to it and
    // the intended race would never happen.
    await settleRun(runId);
    await sealSession();

    const results = await runAs(() =>
      Promise.allSettled([
        svc.approve(plantId, sessionId, created.id),
        prisma.$transaction((tx) => admitRun(tx, { sessionId, provider: 'claude', input: { prompt: 'hola' } })),
      ]),
    );

    const row = await prisma.doctorWriteProposal.findUnique({ where: { id: created.id } });
    expect(['APPROVED', 'EXPIRED']).toContain(row!.status);
    expect(row!.pendingKey).toBeNull();

    // The write must have happened IF AND ONLY IF the proposal was approved.
    const applied = await prisma.plantTaskFrequency.count({ where: { plantId, task: 'WATER' } });
    expect(applied).toBe(row!.status === 'APPROVED' ? 1 : 0);
    // And the approve call's own outcome must agree with the stored status.
    expect(results[0]!.status === 'fulfilled').toBe(row!.status === 'APPROVED');
  });

  it('deleting a session cascades its proposals but LEAVES the audit rows intact', async () => {
    // Spec §5.8 + §7.4: proposals cascade from KnowledgeChatSession; the audit table is append-only and
    // stores `proposalId` with NO FK and NO cascade, so it must OUTLIVE the session that produced it.
    // Adding a "helpful" FK would delete the audit trail, and only a real DB can prove it does not.
    const runId = await makeRun();
    const { svc } = makeProposalsService();
    const created = await svc.create(tokenFor(runId), setWater());
    await runAs(() => svc.approve(plantId, sessionId, created.id));
    expect(await prisma.plantWriteAudit.count({ where: { proposalId: created.id } })).toBe(1);

    await prisma.knowledgeChatSession.delete({ where: { id: sessionId } });

    expect(await prisma.doctorWriteProposal.findUnique({ where: { id: created.id } })).toBeNull();
    const audit = await prisma.plantWriteAudit.findFirst({ where: { proposalId: created.id } });
    expect(audit).not.toBeNull();
    expect(audit!.origin).toBe('DOCTOR');
    // The id is a historical identifier that no longer resolves — correct for an audit log.
    expect(audit!.proposalId).toBe(created.id);
  });

  it('enforces one active run per session across QUEUED and LAUNCHING alike', async () => {
    // The lease state must hold the slot exactly like QUEUED does, or a second turn could be admitted
    // while the first is mid-spawn.
    await prisma.knowledgeChatRun.create({
      data: { sessionId, provider: 'claude', prompt: 'a', status: 'LAUNCHING', activeKey: 'ACTIVE' },
    });
    await expect(
      prisma.knowledgeChatRun.create({
        data: { sessionId, provider: 'claude', prompt: 'b', status: 'QUEUED', activeKey: 'ACTIVE' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
