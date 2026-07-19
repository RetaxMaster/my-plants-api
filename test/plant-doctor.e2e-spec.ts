import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { CodexRoleVerificationService } from '../src/knowledge-chat/codex-role-verification.service.js';
import { DOCTOR_ORCHESTRATOR } from '../src/knowledge-chat/engine/engine-params.js';
import type { KnowledgeChatOrchestrator } from '../src/knowledge-chat/engine/knowledge-chat-orchestrator.js';
import { bootTestApp, cleanupOwners, type ExecuteCall } from './helpers/boot.js';

// End-to-end for the owner-scoped Plant Doctor HTTP surface over the REAL stack (JwtAuthGuard ->
// DoctorScopeGuard -> controller -> shared KnowledgeChatService -> Prisma -> DB). HERMETIC: both engines are
// FAKED (execute is a no-op that only creates the run log, exactly like the KE e2e) — no claude/codex is ever
// spawned. The doctor RUN PATH (workspace + doctor-context.json + scoped token) is the REAL
// DoctorRunContextService, so we assert the injected context without launching a CLI. WeatherService null so
// startup recompute can't hang offline; ImageUploadService faked for the profile/progress writes.
describe('Plant Doctor (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let doctorOrch: KnowledgeChatOrchestrator;

  let executeCalls: ExecuteCall[];

  const n1 = `e2e-pd-o1-${randomUUID()}`;
  const n2 = `e2e-pd-o2-${randomUUID()}`;
  const nAdmin = `e2e-pd-admin-${randomUUID()}`;
  let owner1Id: string; let user1Id: string; let user1Username: string;
  let owner2Id: string; let user2Id: string;
  let adminOwnerId: string; let adminUserId: string; let adminToken: string;
  let token1: string; let token2: string;
  let plantA: string; let plantA2: string; let plantB: string;
  let progressEntryA: string;
  let verification: CodexRoleVerificationService;

  beforeAll(async () => {
    // ONE shared hermetic boot (test/helpers/boot.ts) — never a second copy of the overrides.
    const booted = await bootTestApp();
    app = booted.app;
    prisma = booted.prisma;
    executeCalls = booted.executeCalls;
    doctorOrch = app.get<KnowledgeChatOrchestrator>(DOCTOR_ORCHESTRATOR);

    ({ ownerId: owner1Id, userId: user1Id, token: token1 } = await booted.mkOwner(n1));
    user1Username = n1;
    ({ ownerId: owner2Id, userId: user2Id, token: token2 } = await booted.mkOwner(n2));
    ({ ownerId: adminOwnerId, userId: adminUserId, token: adminToken } = await booted.mkOwner(nAdmin, 'ADMIN'));

    // The Codex fallback gate is default-DENY; pin BOTH engine records to false up front so this suite is
    // deterministic regardless of any record a prior/crashed run left on disk (agent-parity Spec 2 §5).
    verification = booted.verification;
    await verification.write('DOCTOR', false);
    await verification.write('KNOWLEDGE', false);

    const slug = await booted.firstSpeciesSlug();
    plantA = await booted.mkPlant(token1, 'A', slug);
    plantA2 = await booted.mkPlant(token1, 'A2', slug);
    plantB = await booted.mkPlant(token2, 'B', slug);

    // A progress entry on plant A the doctor's `plant-edit` PATCH can target (native Date binding — MariaDB
    // date rule, never an ISO string on a date column).
    progressEntryA = (await prisma.plantProgressEntry.create({
      data: { plantId: plantA, occurredOn: new Date(Date.UTC(2024, 0, 15)), health: 'GOOD', observations: 'seed' },
    })).id;
  });

  afterAll(async () => {
    if (verification) {
      // Restore default-deny so no leftover record on disk leaks Codex into a later e2e FILE (shared state dir).
      await verification.write('DOCTOR', false);
      await verification.write('KNOWLEDGE', false);
    }
    if (prisma) {
      await cleanupOwners(prisma, [owner1Id, owner2Id, adminOwnerId], [user1Id, user2Id, adminUserId]);
    }
    if (app) await app.close();
  });

  const server = () => app.getHttpServer();
  const as1 = (r: request.Test) => r.set('Authorization', `Bearer ${token1}`);
  const as2 = (r: request.Test) => r.set('Authorization', `Bearer ${token2}`);
  const decodeJwt = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));

  let sidA: string; let runA: string;

  it('creates a DOCTOR session pinned to the plant, routes it to the DOCTOR engine, and injects the workspace context', async () => {
    const res = await as1(request(server()).post(`/plants/${plantA}/diagnose/sessions`))
      .send({ prompt: 'Why are the leaves yellow?', provider: 'claude' }).expect(201);
    sidA = res.body.sessionId; runA = res.body.runId;
    expect(res.body.ticket).toBeTruthy();

    const row = await prisma.knowledgeChatSession.findUnique({ where: { id: sidA } });
    expect([row!.kind, row!.plantId, row!.ownerId]).toEqual(['DOCTOR', plantA, owner1Id]);

    // Routed to the DOCTOR engine (never KNOWLEDGE), with the per-run workspace env injected.
    const call = executeCalls.find((c) => c.runId === runA)!;
    expect(call.kind).toBe('DOCTOR');
    const workspace = call.env!.PLANT_DOCTOR_SESSION_WORKSPACE;
    expect(workspace).toContain(sidA);

    // The REAL run-context wrote doctor-context.json with the plant pin + a full-claims scoped token.
    const ctx = JSON.parse(await readFile(join(workspace, 'doctor-context.json'), 'utf8'));
    expect(ctx).toMatchObject({ plantId: plantA, ownerId: owner1Id, months: 3 });
    const claims = decodeJwt(ctx.apiToken);
    expect(claims).toMatchObject({ sub: user1Id, username: user1Username, ownerId: owner1Id, role: 'USER', scope: 'doctor', plantId: plantA });
    expect(claims.jti).toBeTruthy();
    expect(claims.exp).toBeGreaterThan(claims.iat);

    await rm(workspace, { recursive: true, force: true });
  });

  it('lists only THIS plant/owner DOCTOR sessions; an id from another plant or owner 404s everywhere', async () => {
    const list = await as1(request(server()).get(`/plants/${plantA}/diagnose/sessions`)).expect(200);
    expect(list.body.map((s: any) => s.id)).toContain(sidA);
    expect(list.body.every((s: any) => s.kind === 'DOCTOR' && s.plantId === plantA)).toBe(true);

    // Another plant of the SAME owner cannot see it (cross-plant 404).
    await as1(request(server()).get(`/plants/${plantA2}/diagnose/sessions`)).expect(200)
      .then((r) => expect(r.body.map((s: any) => s.id)).not.toContain(sidA));
    await as1(request(server()).get(`/plants/${plantA2}/diagnose/sessions/${sidA}`)).expect(404);
    // Another OWNER cannot even reach plant A's diagnose surface (unowned plant 404).
    await as2(request(server()).get(`/plants/${plantA}/diagnose/sessions`)).expect(404);
  });

  it('socket-ticket 404s for a run whose session belongs to another plant', async () => {
    await as1(request(server()).post(`/plants/${plantA}/diagnose/runs/${runA}/socket-ticket`)).expect(201);
    await as1(request(server()).post(`/plants/${plantA2}/diagnose/runs/${runA}/socket-ticket`)).expect(404);
  });

  it('a second concurrent run on the same session is 409 (single live run — workspace never double-written)', async () => {
    await as1(request(server()).post(`/plants/${plantA}/diagnose/sessions/${sidA}/runs`)).send({ prompt: 'again' }).expect(409);
  });

  it('the Codex gate rejects a codex diagnosis and masks codex in provider-status while unverified (default-deny)', async () => {
    await as1(request(server()).post(`/plants/${plantA}/diagnose/sessions`)).send({ prompt: 'x', provider: 'codex' }).expect(422);
    const ps = await as1(request(server()).get(`/plants/${plantA}/diagnose/provider-status`)).expect(200);
    const codex = ps.body.find((p: any) => p.provider === 'codex');
    expect(codex.available).toBe(false);
  });

  it('deploy-window: an old-code-shaped session INSERT (no kind) lands KNOWLEDGE/null and never surfaces in a doctor list', async () => {
    const legacy = await prisma.knowledgeChatSession.create({ data: { title: 'legacy', provider: 'claude', createdByUserId: user1Id } });
    expect(legacy.kind).toBe('KNOWLEDGE');
    expect(legacy.plantId).toBeNull();
    const list = await as1(request(server()).get(`/plants/${plantA}/diagnose/sessions`)).expect(200);
    expect(list.body.map((s: any) => s.id)).not.toContain(legacy.id);
    await prisma.knowledgeChatSession.delete({ where: { id: legacy.id } });
  });

  // The scoped-token write-pin (Spec 3 §3.3): default-deny narrows a doctor token to a five-endpoint
  // allowlist pinned to its plant. Minted directly (as the run path does) and driven over HTTP.
  describe('scoped doctor token write-pin', () => {
    let docTokenA: string;
    const asDoc = (r: request.Test) => r.set('Authorization', `Bearer ${docTokenA}`);

    it('mints a plant-A doctor token', async () => {
      docTokenA = await app.get(AuthService).mintDoctorToken({
        userId: user1Id, username: user1Username, ownerId: owner1Id, plantId: plantA,
        sessionId: sidA, runId: runA,
      });
      expect(docTokenA).toBeTruthy();
    });

    // The allowlist is now READ-ONLY. The four write endpoints that used to sit on it were revoked
    // when the write-proposal path landed: the doctor's only write is POST .../proposals, gated by the
    // owner's approval. The full mutating surface is asserted 403 in plant-doctor-proposals.e2e-spec.ts.
    it('ACCEPTS the allowlisted READ for plant A, and REJECTS every write that used to be allowed', async () => {
      await asDoc(request(server()).get(`/plants/${plantA}/care`)).expect(200);
      await asDoc(request(server()).patch(`/plants/${plantA}/profile`)).send({ potType: 'plastic', hasDrainage: true }).expect(403);
      await asDoc(request(server()).patch(`/plants/${plantA}/progress/${progressEntryA}`)).field('observations', 'doctor note').expect(403);
      await asDoc(request(server()).put(`/plants/${plantA}/frequency`)).send({ task: 'WATER', intervalDays: 7 }).expect(403);
      await asDoc(request(server()).delete(`/plants/${plantA}/frequency/WATER`)).expect(403);
    });

    it('REJECTS (403) the allowlisted READ for a DIFFERENT plant (the plant pin still holds)', async () => {
      await asDoc(request(server()).get(`/plants/${plantB}/care`)).expect(403);
    });

    it('REJECTS (403) a non-allowlisted endpoint even for plant A (default-deny narrows, never widens)', async () => {
      await asDoc(request(server()).get(`/plants/${plantA}`)).expect(403);
      await asDoc(request(server()).get(`/plants/${plantA}/diagnose/sessions`)).expect(403);
    });

    it('a NORMAL owner token is unaffected on a non-allowlisted route', async () => {
      await as1(request(server()).get(`/plants/${plantA}`)).expect(200);
    });
  });

  it('history / resume / delete of a session 404 cross-plant (same owner) and cross-owner', async () => {
    // Same owner, wrong plant → the session is indistinguishable from not-found on EVERY mutating route.
    await as1(request(server()).get(`/plants/${plantA2}/diagnose/sessions/${sidA}/history`)).expect(404);
    await as1(request(server()).post(`/plants/${plantA2}/diagnose/sessions/${sidA}/runs`)).send({ prompt: 'x' }).expect(404);
    await as1(request(server()).delete(`/plants/${plantA2}/diagnose/sessions/${sidA}`)).expect(404);
    // Another owner cannot even reach plant A's surface (unowned plant 404), so sidA is unreachable to them.
    await as2(request(server()).get(`/plants/${plantA}/diagnose/sessions/${sidA}/history`)).expect(404);
    await as2(request(server()).delete(`/plants/${plantA}/diagnose/sessions/${sidA}`)).expect(404);
    // sidA still exists after all the 404s (nothing was actually deleted).
    await as1(request(server()).get(`/plants/${plantA}/diagnose/sessions/${sidA}`)).expect(200);
  });

  it('the run-log route is owner-scoped, and resume/socket-ticket also 404 cross-owner (completing the matrix)', async () => {
    // The doctor detail's per-turn `logUrl` resolves for the pinned plant's owner...
    await as1(request(server()).get(`/plants/${plantA}/diagnose/runs/${runA}/log`)).expect(200);
    // ...but never for another plant of the same owner, nor for another owner (a KE admin route can't read
    // it either — that scope leak is covered in the unit suite).
    await as1(request(server()).get(`/plants/${plantA2}/diagnose/runs/${runA}/log`)).expect(404);
    await as2(request(server()).get(`/plants/${plantA}/diagnose/runs/${runA}/log`)).expect(404);
    // Cross-owner resume + socket-ticket on plant A are unreachable (unowned plant 404) — the two routes the
    // earlier cross-owner test didn't exercise.
    await as2(request(server()).post(`/plants/${plantA}/diagnose/sessions/${sidA}/runs`)).send({ prompt: 'x' }).expect(404);
    await as2(request(server()).post(`/plants/${plantA}/diagnose/runs/${runA}/socket-ticket`)).expect(404);
  });

  describe('admin acting-as an owner', () => {
    const asAdminActing = (r: request.Test) =>
      r.set('Authorization', `Bearer ${adminToken}`).set('X-Act-As-Owner', owner1Id);

    it('sees the owner\'s doctor sessions and mints a token whose SUBJECT is the owner\'s user (not the admin)', async () => {
      const list = await asAdminActing(request(server()).get(`/plants/${plantA}/diagnose/sessions`)).expect(200);
      expect(list.body.map((s: any) => s.id)).toContain(sidA);

      const res = await asAdminActing(request(server()).post(`/plants/${plantA}/diagnose/sessions`))
        .send({ prompt: 'acting as the owner', provider: 'claude' }).expect(201);
      const call = executeCalls.find((c) => c.runId === res.body.runId)!;
      const workspace = call.env!.PLANT_DOCTOR_SESSION_WORKSPACE;
      const ctx = JSON.parse(await readFile(join(workspace, 'doctor-context.json'), 'utf8'));
      const claims = decodeJwt(ctx.apiToken);
      // The scoped token identifies OWNER1's user (role USER), never the operating ADMIN (Spec 3 §3.3).
      expect(claims).toMatchObject({ sub: user1Id, username: user1Username, ownerId: owner1Id, role: 'USER', scope: 'doctor', plantId: plantA });
      expect(claims.sub).not.toBe(adminUserId);
      const row = await prisma.knowledgeChatSession.findUnique({ where: { id: res.body.sessionId } });
      expect(row!.ownerId).toBe(owner1Id);
      await rm(workspace, { recursive: true, force: true });
    });

    it('a plain admin (NO acting-as header) cannot reach another owner\'s plant (404)', async () => {
      await request(server()).get(`/plants/${plantA}/diagnose/sessions`).set('Authorization', `Bearer ${adminToken}`).expect(404);
    });
  });

  describe('Codex fallback gate — dynamic per-engine record, both pipelines, sealed-aware', () => {
    it('DOCTOR: the record flips codex availability + create acceptance dynamically (no restart)', async () => {
      await verification.write('DOCTOR', true);
      const psOn = await as1(request(server()).get(`/plants/${plantA}/diagnose/provider-status?force=1`)).expect(200);
      expect(psOn.body.find((p: any) => p.provider === 'codex').available).toBe(true);
      const created = await as1(request(server()).post(`/plants/${plantA}/diagnose/sessions`))
        .send({ prompt: 'codex allowed now', provider: 'codex' }).expect(201);
      const call = executeCalls.find((c) => c.runId === created.body.runId);
      if (call?.env?.PLANT_DOCTOR_SESSION_WORKSPACE) await rm(call.env.PLANT_DOCTOR_SESSION_WORKSPACE, { recursive: true, force: true });

      await verification.write('DOCTOR', false); // dynamic read → the running process fails closed again
      const psOff = await as1(request(server()).get(`/plants/${plantA}/diagnose/provider-status?force=1`)).expect(200);
      expect(psOff.body.find((p: any) => p.provider === 'codex').available).toBe(false);
      await as1(request(server()).post(`/plants/${plantA}/diagnose/sessions`)).send({ prompt: 'nope', provider: 'codex' }).expect(422);
    });

    it('DOCTOR: a SEALED codex session is refused while unverified whether provider is omitted OR spoofed claude', async () => {
      // Sealed = providerSessionId set; the run path ignores the request provider and uses session.provider.
      const sealed = await prisma.knowledgeChatSession.create({
        data: { title: 'sealed codex', provider: 'codex', kind: 'DOCTOR', plantId: plantA, ownerId: owner1Id, providerSessionId: 'codex-thread-1' },
      });
      await as1(request(server()).post(`/plants/${plantA}/diagnose/sessions/${sealed.id}/runs`)).send({ prompt: 'omit' }).expect(422);
      await as1(request(server()).post(`/plants/${plantA}/diagnose/sessions/${sealed.id}/runs`)).send({ prompt: 'spoof', provider: 'claude' }).expect(422);
      await prisma.knowledgeChatSession.delete({ where: { id: sealed.id } });
    });

    it('KE: the KE controller reflects ITS OWN engine record, independently of the doctor record', async () => {
      const off = await request(server()).get('/knowledge-chat/provider-status?force=1').set('Authorization', `Bearer ${adminToken}`).expect(200);
      expect(off.body.find((p: any) => p.provider === 'codex').available).toBe(false);
      await verification.write('KNOWLEDGE', true);
      const on = await request(server()).get('/knowledge-chat/provider-status?force=1').set('Authorization', `Bearer ${adminToken}`).expect(200);
      expect(on.body.find((p: any) => p.provider === 'codex').available).toBe(true);
      await verification.write('KNOWLEDGE', false);
    });
  });

  it('finalizing the run through the REAL orchestrator unblocks delete, which sweeps the session', async () => {
    await doctorOrch.runStarted(runA, { pid: 4242, procStartTime: '1', sessionId: 'uuid-doc-abc' });
    await doctorOrch.runFinished(runA, { exitCode: 0, stopped: false, stderrTail: null });
    await as1(request(server()).delete(`/plants/${plantA}/diagnose/sessions/${sidA}`)).expect(200);
    await as1(request(server()).get(`/plants/${plantA}/diagnose/sessions/${sidA}`)).expect(404);
  });
});
