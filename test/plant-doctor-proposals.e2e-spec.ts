import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service.js';
import { bootTestApp, cleanupOwners, type BootedApp } from './helpers/boot.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE REGRESSION GUARD FOR THE WHOLE FEATURE (spec §10).
 *
 *  A doctor-scoped token must be 403 on EVERY domain-mutating endpoint. Its ONLY write is
 *  POST /plants/:id/diagnose/proposals, and that write must pass through the owner's approval.
 *
 *  If this file goes red because someone re-granted @DoctorAllowed() to a mutating handler "to
 *  speed things up" — that is precisely the invariant this feature exists to hold. The doctor
 *  agent is an advisor with a proposal channel, not an actor with write access. Restoring direct
 *  write access does not "unblock" the agent; it removes the owner from their own plants.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe('doctor token cannot mutate any domain record (e2e)', () => {
  let ctx: BootedApp;
  let ownerId: string;
  let userId: string;
  let ownerToken: string;
  let plantId: string;
  let otherPlantId: string;
  let entryId: string;
  let doctorToken: string;

  const name = `e2e-prop-o1-${randomUUID()}`;

  beforeAll(async () => {
    ctx = await bootTestApp();
    await ctx.verification.write('DOCTOR', false);
    await ctx.verification.write('KNOWLEDGE', false);

    ({ ownerId, userId, token: ownerToken } = await ctx.mkOwner(name));
    const slug = await ctx.firstSpeciesSlug();
    plantId = await ctx.mkPlant(ownerToken, 'P', slug);
    otherPlantId = await ctx.mkPlant(ownerToken, 'P2', slug);

    // Native Date binding on a @db.Date column — never an ISO string (MariaDB timezone rule).
    entryId = (
      await ctx.prisma.plantProgressEntry.create({
        data: { plantId, occurredOn: new Date(Date.UTC(2024, 0, 15)), health: 'GOOD', observations: 'seed' },
      })
    ).id;

    doctorToken = await ctx.app.get(AuthService).mintDoctorToken({
      userId,
      username: name,
      ownerId,
      plantId,
      sessionId: 'sess-guard',
      runId: 'run-guard',
    });
  });

  afterAll(async () => {
    if (ctx?.verification) {
      await ctx.verification.write('DOCTOR', false);
      await ctx.verification.write('KNOWLEDGE', false);
    }
    if (ctx?.prisma) await cleanupOwners(ctx.prisma, [ownerId], [userId]);
    if (ctx?.app) await ctx.app.close();
  });

  /**
   * Every domain-mutating endpoint reachable with a plant id. The four that carried @DoctorAllowed()
   * are marked; the rest were already denied by the default-deny guard and are included so the guard
   * covers the whole mutating surface, not just the endpoints this change happened to touch.
   */
  const mutatingEndpoints = () =>
    [
      { method: 'patch', path: `/plants/${plantId}/profile`, body: { potType: 'plastic' }, wasAllowed: true },
      { method: 'patch', path: `/plants/${plantId}/progress/${entryId}`, body: { observations: 'x' }, wasAllowed: true },
      { method: 'put', path: `/plants/${plantId}/frequency`, body: { task: 'WATER', intervalDays: 5 }, wasAllowed: true },
      { method: 'delete', path: `/plants/${plantId}/frequency/WATER`, body: undefined, wasAllowed: true },
      { method: 'post', path: `/plants/${plantId}/feedback`, body: { task: 'WATER', type: 'DONE', occurredOn: '2026-07-18' }, wasAllowed: false },
      { method: 'patch', path: `/plants/${plantId}`, body: { nickname: 'hacked' }, wasAllowed: false },
      { method: 'post', path: `/plants/${plantId}/progress`, body: { health: 'GOOD' }, wasAllowed: false },
      { method: 'delete', path: `/plants/${plantId}/cover-photo`, body: undefined, wasAllowed: false },
      { method: 'put', path: `/plants/${plantId}/cover-photo`, body: undefined, wasAllowed: false },
      // Added by the tail review: these were denied all along, but the guard did not COVER them, so a
      // future accidental @DoctorAllowed() on any of them would not have turned this test red.
      { method: 'delete', path: `/plants/${plantId}/progress/${entryId}`, body: undefined, wasAllowed: false },
      // The photo id need not exist: the global guard runs BEFORE the handler resolves the entity, so a
      // doctor token is refused at the guard. Were the guard removed, this returns 404 rather than 403 —
      // still red, which is what matters. The ROUTE is what must be real, and it is.
      { method: 'post', path: `/plants/${plantId}/progress/${entryId}/photos/00000000-0000-4000-8000-000000000000/retry`, body: undefined, wasAllowed: false },
    ] as const;
  // NOTE: every path above must be a route that EXISTS. A non-existent route returns 404 (no handler),
  // which would pass a "not 2xx" assertion while proving nothing about the guard — the test would be
  // green because the endpoint is missing, not because access is denied.

  it('403s on every domain-mutating endpoint for its OWN pinned plant', async () => {
    for (const { method, path, body } of mutatingEndpoints()) {
      const req = (request(ctx.server()) as never as Record<string, (p: string) => request.Test>)[method]!(path).set(
        'Authorization',
        `Bearer ${doctorToken}`,
      );
      const res = await (body ? req.send(body) : req);
      expect(res.status, `${method.toUpperCase()} ${path} must be 403 for a doctor token`).toBe(403);
    }
  });

  /**
   * Mutating endpoints that are NOT scoped to a plant id. The default-deny guard is global, so these are
   * refused for the same reason — but the guard is only as good as what this test covers, and the
   * previous list was entirely plant-scoped. A doctor token creating a plant, editing a shared place, or
   * publishing a blog post would all have been catastrophic and invisible here.
   *
   * These are deliberately NOT run through the plant-id swap below: there is no plant id in them.
   */
  const globalMutatingEndpoints = () =>
    [
      { method: 'post', path: '/plants', body: { speciesSlug: 'x', placeId: 'x' } },
      { method: 'post', path: '/places', body: { name: 'x', cityId: 'x', indoor: true } },
      { method: 'patch', path: '/places/00000000-0000-4000-8000-000000000000', body: { name: 'x' } },
      { method: 'post', path: '/cities', body: { name: 'x', latitude: 0, longitude: 0 } },
      { method: 'post', path: '/cities/00000000-0000-4000-8000-000000000000/make-primary', body: {} },
      { method: 'post', path: '/care-plan/recompute', body: {} },
      { method: 'post', path: '/media', body: {} },
      { method: 'delete', path: '/media/00000000-0000-4000-8000-000000000000', body: undefined },
      { method: 'post', path: '/blogposts', body: { title: 'x' } },
      { method: 'patch', path: '/blogposts/some-slug', body: { title: 'x' } },
      { method: 'delete', path: '/blogposts/some-slug', body: undefined },
      { method: 'post', path: '/blogposts/some-slug/cover', body: {} },
      { method: 'post', path: '/moving/schedule', body: { plantId, placeId: 'x' } },
      // Both chat surfaces: an agent must not be able to open, drive or delete conversations — its own
      // or the admin Knowledge Engine's.
      { method: 'post', path: '/knowledge-chat/sessions', body: { title: 'x' } },
      { method: 'post', path: '/knowledge-chat/sessions/x/runs', body: { prompt: 'x' } },
      { method: 'delete', path: '/knowledge-chat/sessions/x', body: undefined },
      { method: 'post', path: '/knowledge-chat/runs/x/socket-ticket', body: {} },
      { method: 'post', path: `/plants/${plantId}/diagnose/sessions`, body: { title: 'x' } },
      { method: 'post', path: `/plants/${plantId}/diagnose/sessions/x/runs`, body: { prompt: 'x' } },
      { method: 'delete', path: `/plants/${plantId}/diagnose/sessions/x`, body: undefined },
      { method: 'post', path: `/plants/${plantId}/diagnose/runs/x/socket-ticket`, body: {} },
      // The agent must not be able to RESOLVE its own proposal — that is the owner's decision, and it is
      // the whole consent gate. `PATCH …/settings` is covered by its own dedicated test above.
      { method: 'post', path: `/plants/${plantId}/diagnose/sessions/sess-guard/proposals/x/approve`, body: {} },
      { method: 'post', path: `/plants/${plantId}/diagnose/sessions/sess-guard/proposals/x/decline`, body: {} },
    ] as const;

  it('403s on every mutating endpoint that is not scoped to a plant either', async () => {
    for (const { method, path, body } of globalMutatingEndpoints()) {
      const req = (request(ctx.server()) as never as Record<string, (p: string) => request.Test>)[method]!(path).set(
        'Authorization',
        `Bearer ${doctorToken}`,
      );
      const res = await req.send(body);
      // 403 specifically — never merely "not 2xx". A 404 would pass a weaker assertion while proving the
      // route is missing rather than the token refused.
      expect(res.status, `${method.toUpperCase()} ${path} must be 403 for a doctor token`).toBe(403);
    }
  });

  it('403s on those endpoints for a DIFFERENT plant too (the pin is not the only thing denying it)', async () => {
    // Belt and braces: were the allowlist ever restored, a plant-pin bug would be the only remaining
    // barrier. This asserts the denial does not depend on the pin.
    for (const { method, path } of mutatingEndpoints()) {
      const swapped = path.replace(plantId, otherPlantId);
      const req = (request(ctx.server()) as never as Record<string, (p: string) => request.Test>)[method]!(
        swapped,
      ).set('Authorization', `Bearer ${doctorToken}`);
      const res = await req.send({ task: 'WATER', intervalDays: 5 });
      expect(res.status, `${method.toUpperCase()} ${swapped}`).toBe(403);
    }
  });

  it('leaves the plant genuinely unmodified after every rejected attempt', async () => {
    // A 403 that still wrote would be the worst possible outcome: the invariant would LOOK held while
    // the data moved. Asserted against the DB, not the response.
    const plant = await ctx.prisma.plant.findUnique({ where: { id: plantId } });
    const entry = await ctx.prisma.plantProgressEntry.findUnique({ where: { id: entryId } });
    const freq = await ctx.prisma.plantTaskFrequency.findMany({ where: { plantId } });
    const profile = await ctx.prisma.plantProfile.findUnique({ where: { plantId } });
    expect(plant?.nickname).not.toBe('hacked');
    expect(entry?.observations).toBe('seed');
    expect(freq).toHaveLength(0);
    expect(profile).toBeNull();
  });

  it('still serves the OWNER session token on those endpoints (only the doctor lost access)', async () => {
    const res = await request(ctx.server())
      .put(`/plants/${plantId}/frequency`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ task: 'WATER', intervalDays: 5 });
    expect(res.status).toBeLessThan(300);

    const patched = await request(ctx.server())
      .patch(`/plants/${plantId}/profile`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ potType: 'plastic' });
    expect(patched.status).toBeLessThan(300);
  });

  it('keeps GET /plants/:id/care reachable by the doctor token (reads are unchanged)', async () => {
    const res = await request(ctx.server())
      .get(`/plants/${plantId}/care`)
      .set('Authorization', `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  /**
   * The five proposal endpoints are MOUNTED and answer as themselves.
   *
   * This exists because "the controller compiles and the app boots" proves neither. A controller that is
   * registered but mis-mounted (a wrong path prefix, a segment clash with `PlantDoctorController`'s own
   * `sessions/:sid` routes) fails ONLY at request time, and it fails as a 404 — which is exactly the
   * status several legitimate outcomes here also produce. So each assertion below pins a response that a
   * missing route could not produce.
   */
  describe('the proposal endpoints are mounted', () => {
    let sessionId: string;
    const base = () => `/plants/${plantId}/diagnose/sessions/${sessionId}`;

    beforeAll(async () => {
      const s = await ctx.prisma.knowledgeChatSession.create({
        data: { title: 'mount check', kind: 'DOCTOR', plantId, ownerId, provider: 'claude' },
      });
      sessionId = s.id;
    });

    it('GET proposals/pending answers 200 with null when nothing is pending', async () => {
      const res = await request(ctx.server()).get(`${base()}/proposals/pending`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});  // an empty 200 body — Nest serializes a null return as no content
    });

    it('GET and PATCH settings round-trip the owner-only switch', async () => {
      const read = await request(ctx.server()).get(`${base()}/settings`).set('Authorization', `Bearer ${ownerToken}`);
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ skipPermissions: false });

      const write = await request(ctx.server())
        .patch(`${base()}/settings`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ skipPermissions: true });
      expect(write.status).toBe(200);
      expect(write.body).toEqual({ skipPermissions: true });

      // Provenance is recorded, not just the boolean (spec 6.4) — this is what makes an auto-approve
      // attributable later.
      const row = await ctx.prisma.knowledgeChatSession.findUnique({ where: { id: sessionId } });
      expect(row!.skipPermissionsSetByUserId).toBe(userId);
      expect(row!.skipPermissionsSetAt).toBeInstanceOf(Date);

      await request(ctx.server())
        .patch(`${base()}/settings`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ skipPermissions: false });
    });

    it('403s POST proposals for an ordinary OWNER token — @DoctorAllowed alone would have admitted it', async () => {
      const res = await request(ctx.server())
        .post(`${base()}/proposals`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ summary: 's', operations: [{ type: 'frequency.clear', task: 'WATER' }] });
      expect(res.status).toBe(403);
    });

    it('403s PATCH settings for a doctor token (an agent cannot disable its own supervision)', async () => {
      const res = await request(ctx.server())
        .patch(`${base()}/settings`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ skipPermissions: true });
      expect(res.status).toBe(403);
    });

    it('403s a doctor token filing against a session it is not pinned to', async () => {
      // The token above is pinned to `sess-guard`; this path names the real session. The seal — not the
      // plant pin — is what must reject it (spec 5.2).
      const res = await request(ctx.server())
        .post(`${base()}/proposals`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ summary: 's', operations: [{ type: 'frequency.clear', task: 'WATER' }] });
      expect(res.status).toBe(403);
    });

    it('400s a malformed proposal body before any scope check leaks information', async () => {
      const res = await request(ctx.server())
        .post(`${base()}/proposals`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ summary: 's', operations: [{ type: 'nope' }] });
      expect(res.status).toBe(400);
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE FULL PROPOSAL LIFECYCLE (spec §10).
 *
 *  Everything above proves the doctor CANNOT write. This proves the path that replaced it actually
 *  works end to end: propose → server-rendered banner → owner approves → the data really changed.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe('doctor write proposals — full lifecycle (e2e)', () => {
  let ctx: BootedApp;
  let ownerId: string;
  let userId: string;
  let ownerToken: string;
  let adminToken: string;
  let plantId: string;
  let otherPlantId: string;
  let sessionId: string;
  let runId: string;
  let doctorToken: string;
  let otherSessionId: string;
  let terminalRunDoctorToken: string;
  let entryId: string;
  let otherPlantEntryId: string;
  let foreign: { ownerId: string; userId: string; plantId: string; sessionId: string; proposalId: string };

  const name = `e2e-life-o1-${randomUUID()}`;
  const adminName = `e2e-life-admin-${randomUUID()}`;
  const foreignName = `e2e-life-o2-${randomUUID()}`;

  const base = () => `/plants/${plantId}/diagnose/sessions/${sessionId}`;
  const asOwner = (r: request.Test) => r.set('Authorization', `Bearer ${ownerToken}`);
  const asDoctor = (r: request.Test) => r.set('Authorization', `Bearer ${doctorToken}`);

  const post = (body: unknown) => asDoctor(request(ctx.server()).post(`${base()}/proposals`)).send(body as never);
  const propose = (operations: unknown[], summary = 's') => post({ summary, operations });
  const ownerGet = (suffix: string, prefix = base()) => asOwner(request(ctx.server()).get(`${prefix}${suffix}`));
  const ownerPost = (suffix: string, body: unknown) =>
    asOwner(request(ctx.server()).post(`${base()}${suffix}`)).send(body as never);

  async function proposeAndGetPending(operations: unknown[] = [{ type: 'frequency.set', task: 'WATER', intervalDays: 5 }]) {
    await propose(operations).expect(201);
    const res = await ownerGet('/proposals/pending').expect(200);
    return res.body as { id: string; operations: { type: string; targetLabel: string; changes: unknown[] }[]; summary: string };
  }

  /**
   * Release the session's active slot and seal it, so the next decline/turn can actually be admitted.
   *
   * Every proposal here is filed by a live, non-terminal run (the propose endpoint rejects a terminal
   * `runId`), and that run holds `activeKey`. "The session is idle" is therefore NEVER true by default —
   * it must be established. A test that skips this silently exercises the deferred branch instead.
   */
  async function makeSessionIdle(id = sessionId) {
    await ctx.prisma.knowledgeChatRun.updateMany({
      where: { sessionId: id, activeKey: { not: null } },
      data: { status: 'SUCCEEDED', activeKey: null, finishedAt: new Date() },
    });
    await ctx.prisma.knowledgeChatSession.update({
      where: { id },
      data: { providerSessionId: `prov-e2e-${randomUUID()}`, provider: 'claude' },
    });
  }

  /** A fresh live run + a doctor token sealed to it, restoring the "a run is active" precondition. */
  async function freshRun() {
    await ctx.prisma.knowledgeChatRun.updateMany({
      where: { sessionId, activeKey: { not: null } },
      data: { status: 'SUCCEEDED', activeKey: null, finishedAt: new Date() },
    });
    const run = await ctx.prisma.knowledgeChatRun.create({
      data: { sessionId, provider: 'claude', prompt: 'p', status: 'RUNNING', activeKey: 'ACTIVE' },
    });
    runId = run.id;
    doctorToken = await ctx.app.get(AuthService).mintDoctorToken({
      userId, username: name, ownerId, plantId, sessionId, runId,
    });
  }

  beforeAll(async () => {
    ctx = await bootTestApp();
    await ctx.verification.write('DOCTOR', false);
    await ctx.verification.write('KNOWLEDGE', false);

    ({ ownerId, userId, token: ownerToken } = await ctx.mkOwner(name));
    ({ token: adminToken } = await ctx.mkOwner(adminName, 'ADMIN'));
    const slug = await ctx.firstSpeciesSlug();
    plantId = await ctx.mkPlant(ownerToken, 'L', slug);
    otherPlantId = await ctx.mkPlant(ownerToken, 'L2', slug);

    const s = await ctx.prisma.knowledgeChatSession.create({
      data: { title: 'lifecycle', kind: 'DOCTOR', plantId, ownerId, provider: 'claude' },
    });
    sessionId = s.id;
    otherSessionId = (await ctx.prisma.knowledgeChatSession.create({
      data: { title: 'sibling', kind: 'DOCTOR', plantId, ownerId, provider: 'claude' },
    })).id;

    // A doctor token whose run is already terminal — §5.2's run seal must reject it.
    const deadRun = await ctx.prisma.knowledgeChatRun.create({
      data: { sessionId, provider: 'claude', prompt: 'p', status: 'SUCCEEDED', finishedAt: new Date() },
    });
    terminalRunDoctorToken = await ctx.app.get(AuthService).mintDoctorToken({
      userId, username: name, ownerId, plantId, sessionId, runId: deadRun.id,
    });

    // A SECOND owner, with their own plant, session and pending proposal — the cross-owner 404 fixture.
    const f = await ctx.mkOwner(foreignName);
    const fPlant = await ctx.mkPlant(f.token, 'F', slug);
    const fSession = await ctx.prisma.knowledgeChatSession.create({
      data: { title: 'foreign', kind: 'DOCTOR', plantId: fPlant, ownerId: f.ownerId, provider: 'claude' },
    });
    const fRun = await ctx.prisma.knowledgeChatRun.create({
      data: { sessionId: fSession.id, provider: 'claude', prompt: 'p', status: 'RUNNING', activeKey: 'ACTIVE' },
    });
    const fProposal = await ctx.prisma.doctorWriteProposal.create({
      data: {
        sessionId: fSession.id, runId: fRun.id, plantId: fPlant, ownerId: f.ownerId,
        operations: JSON.stringify([{ type: 'frequency.clear', task: 'WATER' }]),
        snapshot: JSON.stringify([{ intervalDays: null }]),
        summary: 'foreign', status: 'PENDING', pendingKey: 'PENDING',
      },
    });
    foreign = { ownerId: f.ownerId, userId: f.userId, plantId: fPlant, sessionId: fSession.id, proposalId: fProposal.id };

    await freshRun();
  }, 60_000);

  beforeEach(async () => {
    // Each test starts from a clean slate: no proposals, no queued message, no frequencies, a LIVE run.
    await ctx.prisma.doctorWriteProposal.deleteMany({ where: { sessionId } });
    await ctx.prisma.plantWriteAudit.deleteMany({ where: { plantId } });
    await ctx.prisma.plantTaskFrequency.deleteMany({ where: { plant: { ownerId } } });
    await ctx.prisma.knowledgeChatSession.update({
      where: { id: sessionId },
      data: { pendingSystemMessage: null, pendingSystemMessageProposalId: null, skipPermissions: false, skipPermissionsSetByUserId: null, skipPermissionsSetAt: null },
    });
    // A known WATER cadence, so `before` values in the banner are deterministic.
    await asOwner(request(ctx.server()).put(`/plants/${plantId}/frequency`)).send({ task: 'WATER', intervalDays: 7 }).expect(200);
    entryId = (await ctx.prisma.plantProgressEntry.create({
      data: { plantId, occurredOn: new Date(Date.UTC(2024, 0, 15)), health: 'GOOD', observations: 'seed' },
    })).id;
    otherPlantEntryId = (await ctx.prisma.plantProgressEntry.create({
      data: { plantId: otherPlantId, occurredOn: new Date(Date.UTC(2024, 0, 16)), health: 'GOOD' },
    })).id;
    await freshRun();
  }, 30_000);

  afterEach(async () => {
    await ctx.prisma.plantProgressEntry.deleteMany({ where: { plant: { ownerId } } }).catch(() => {});
  });

  afterAll(async () => {
    if (ctx?.prisma) {
      await ctx.prisma.plantWriteAudit.deleteMany({ where: { plantId } }).catch(() => {});
      await ctx.prisma.plantWriteAudit.deleteMany({ where: { plantId: foreign.plantId } }).catch(() => {});
      await cleanupOwners(ctx.prisma, [ownerId, foreign.ownerId], [userId, foreign.userId]);
      await ctx.prisma.user.deleteMany({ where: { username: adminName } }).catch(() => {});
      await ctx.prisma.owner.deleteMany({ where: { name: adminName } }).catch(() => {});
    }
    if (ctx?.app) await ctx.app.close();
  }, 30_000);

  // ─────────────────────────────── authorization + sealing ───────────────────────────────

  describe('propose endpoint authorization', () => {
    const body = { summary: 's', operations: [{ type: 'frequency.set', task: 'WATER', intervalDays: 5 }] };

    it('403s for an ordinary owner session token', async () => {
      // @DoctorAllowed alone would ADMIT this — it only governs what a DOCTOR token may reach. The
      // handler's explicit scope check is what refuses it.
      const res = await asOwner(request(ctx.server()).post(`${base()}/proposals`)).send(body);
      expect(res.status).toBe(403);
    });

    it('403s for an ADMIN session token', async () => {
      const res = await request(ctx.server())
        .post(`${base()}/proposals`).set('Authorization', `Bearer ${adminToken}`).send(body);
      expect(res.status).toBe(403);
    });

    it('400s when the body carries sessionId/runId/plantId/ownerId (unknown property, never ignored)', async () => {
      // Silently ignoring them would be worse than rejecting: the agent would believe it had chosen the
      // target, while the server derived a different one from the token.
      //
      // ⚠️ All FOUR sealed identities are covered. `ownerId` was missing, and it is the one whose silent
      // acceptance would be worst — it is the tenancy boundary, not just the target.
      for (const extra of [{ sessionId: 'x' }, { runId: 'x' }, { plantId: 'x' }, { ownerId: 'x' }]) {
        const res = await post({ ...body, ...extra });
        expect(res.status, JSON.stringify(extra)).toBe(400);
      }
    });

    it('403s a doctor token whose runId is terminal', async () => {
      const res = await request(ctx.server())
        .post(`${base()}/proposals`).set('Authorization', `Bearer ${terminalRunDoctorToken}`).send(body);
      expect(res.status).toBe(403);
    });

    it('403s a doctor token filing against another session of the SAME plant', async () => {
      // That other session may have Skip Permissions on — which would auto-apply this unseen (§5.2).
      const res = await asDoctor(
        request(ctx.server()).post(`/plants/${plantId}/diagnose/sessions/${otherSessionId}/proposals`),
      ).send(body);
      expect(res.status).toBe(403);
    });
  });

  // ─────────────────────────────── validation ───────────────────────────────

  describe('propose validation', () => {
    it('400s an over-long summary and an 11-operation array', async () => {
      expect((await post({ summary: 'x'.repeat(501), operations: [{ type: 'frequency.clear', task: 'WATER' }] })).status).toBe(400);
      expect((await post({ summary: 's', operations: Array.from({ length: 11 }, () => ({ type: 'frequency.clear', task: 'WATER' })) })).status).toBe(400);
    });

    it('accepts null as the clear token for observations and sizeCm, and [] for tags', async () => {
      const res = await propose([{ type: 'progress.update', entryId, observations: null, sizeCm: null, tags: [] }]);
      expect(res.status).toBe(201);
    });

    it('400s health: null, occurredOn: null, tags: null and an empty string as a clear token', async () => {
      expect((await propose([{ type: 'progress.update', entryId, health: null }])).status).toBe(400);
      expect((await propose([{ type: 'progress.update', entryId, occurredOn: null }])).status).toBe(400);
      expect((await propose([{ type: 'progress.update', entryId, tags: null }])).status).toBe(400);
      expect((await propose([{ type: 'progress.update', entryId, sizeCm: '' }])).status).toBe(400);
    });

    it('400s overlapping write-sets', async () => {
      expect((await propose([{ type: 'profile.update', potType: 'plastic' }, { type: 'profile.update', potType: 'terracotta' }])).status).toBe(400);
      expect((await propose([{ type: 'progress.update', entryId, observations: 'a' }, { type: 'progress.delete', entryId }])).status).toBe(400);
    });

    it('rejects a cross-plant entryId at PROPOSE time with 400 — the owner never sees a doomed banner', async () => {
      const res = await propose([{ type: 'progress.update', entryId: otherPlantEntryId, observations: 'x' }]);
      expect(res.status).toBe(400);
    });
  });

  // ─────────────────────────────── lifecycle ───────────────────────────────

  describe('lifecycle', () => {
    it('propose -> banner shows the structured list -> approve -> the data actually changed', async () => {
      // The summary is deliberately misleading: consent binds to `changes[]`, never to the agent's prose.
      const pending = await proposeAndGetPending([{ type: 'frequency.set', task: 'WATER', intervalDays: 5 }]);
      expect(pending.operations[0]).toMatchObject({ type: 'frequency.set', targetLabel: 'WATER' });
      expect(pending.operations[0].changes).toEqual([{ field: 'Every (days)', before: '7', after: '5' }]);

      const approve = await ownerPost(`/proposals/${pending.id}/approve`, {});
      expect(approve.status).toBe(200);

      const freq = await ownerGet('/frequency', `/plants/${plantId}`).expect(200);
      expect(freq.body).toContainEqual(expect.objectContaining({ task: 'WATER', intervalDays: 5 }));
    });

    it('applies exactly what the structured list said, even when the summary claims otherwise', async () => {
      await propose([{ type: 'frequency.set', task: 'WATER', intervalDays: 5 }], 'I will update the nickname').expect(201);
      const pending = (await ownerGet('/proposals/pending').expect(200)).body;
      expect(pending.summary).toBe('I will update the nickname'); // caption only
      expect(pending.operations[0].type).toBe('frequency.set');

      await ownerPost(`/proposals/${pending.id}/approve`, {}).expect(200);

      const plant = await ctx.prisma.plant.findUnique({ where: { id: plantId } });
      expect(plant!.nickname).toBeNull(); // the prose changed nothing
      expect(await ctx.prisma.plantTaskFrequency.count({ where: { plantId, task: 'WATER', intervalDays: 5 } })).toBe(1);
    });

    it('a non-empty body on approve or decline is 400', async () => {
      const p = await proposeAndGetPending();
      expect((await ownerPost(`/proposals/${p.id}/approve`, { force: true })).status).toBe(400);
      expect((await ownerPost(`/proposals/${p.id}/decline`, { reason: 'no' })).status).toBe(400);
    });

    it('a second propose expires the first, and approving the expired one 409s with its terminal status', async () => {
      const first = await proposeAndGetPending();
      await propose([{ type: 'frequency.clear', task: 'MIST' }], 's2').expect(201);
      const res = await ownerPost(`/proposals/${first.id}/approve`, {});
      expect(res.status).toBe(409);
      expect(res.body.status).toBe('EXPIRED');
    });

    it('a new prompt turn expires the pending proposal and prefixes the not-approved nudge', async () => {
      const p = await proposeAndGetPending();
      await makeSessionIdle();

      const turn = await asOwner(request(ctx.server()).post(`${base().replace(/\/sessions\/.*$/, '')}/sessions/${sessionId}/runs`))
        .send({ prompt: 'why is it yellow?' }).expect(201);

      const row = await ctx.prisma.doctorWriteProposal.findUnique({ where: { id: p.id } });
      expect(row!.status).toBe('EXPIRED');
      const run = await ctx.prisma.knowledgeChatRun.findUnique({ where: { id: turn.body.runId } });
      expect(run!.prompt).toBe('[system] The user still has not approved the request.\n\nwhy is it yellow?');
      expect(run!.systemMessageState).toBe('CONSUMED');
    });

    it('a command turn does NOT consume the queued message and is not prefixed', async () => {
      const p = await proposeAndGetPending();
      await makeSessionIdle();
      // First a prompt turn to expire the proposal and queue the nudge... then settle it and send a command.
      await ctx.prisma.doctorWriteProposal.updateMany({ where: { id: p.id }, data: { status: 'EXPIRED', pendingKey: null } });
      await ctx.prisma.knowledgeChatSession.update({
        where: { id: sessionId },
        data: { pendingSystemMessage: '[system] The user declined your request.', pendingSystemMessageProposalId: p.id },
      });

      const turn = await asOwner(request(ctx.server()).post(`/plants/${plantId}/diagnose/sessions/${sessionId}/runs`))
        .send({ command: { name: 'compact', args: '' } }).expect(201);

      const run = await ctx.prisma.knowledgeChatRun.findUnique({ where: { id: turn.body.runId } });
      expect(run!.prompt).toBeNull();
      expect(run!.commandName).toBe('compact');
      expect(run!.systemMessageState).toBeNull();
      // Prefixing prose onto a command would corrupt it, so the message waits for the next PROMPT turn.
      const session = await ctx.prisma.knowledgeChatSession.findUnique({ where: { id: sessionId } });
      expect(session!.pendingSystemMessage).toBe('[system] The user declined your request.');
    });

    it('declining on an IDLE session starts a new run carrying the declined [system] message', async () => {
      const p = await proposeAndGetPending();
      // MAKE THE SESSION IDLE. Without this the decline takes the "a run is active" branch and this test
      // would pass while proving the OPPOSITE of its name.
      await makeSessionIdle();
      const runsBefore = await ctx.prisma.knowledgeChatRun.count({ where: { sessionId } });

      const res = await ownerPost(`/proposals/${p.id}/decline`, {});
      expect(res.status).toBe(200);

      const runsAfter = await ctx.prisma.knowledgeChatRun.findMany({ where: { sessionId }, orderBy: { createdAt: 'desc' } });
      expect(runsAfter.length).toBe(runsBefore + 1);
      expect(runsAfter[0]!.prompt).toContain('[system] The user declined your request.');
      expect(runsAfter[0]!.systemMessageState).toBe('CONSUMED');

      const session = await ctx.prisma.knowledgeChatSession.findUnique({ where: { id: sessionId } });
      expect(session!.pendingSystemMessage).toBeNull(); // consumed, not duplicated
    });

    it('declining records the decision and queues the message even while a run is active', async () => {
      // The mirror case: recording the decision must NEVER depend on run scheduling (§5.3.1).
      const p = await proposeAndGetPending();
      expect(await ctx.prisma.knowledgeChatRun.count({ where: { sessionId, activeKey: { not: null } } })).toBe(1);
      const runsBefore = await ctx.prisma.knowledgeChatRun.count({ where: { sessionId } });

      const res = await ownerPost(`/proposals/${p.id}/decline`, {});
      expect(res.status).toBe(200);

      const row = await ctx.prisma.doctorWriteProposal.findUnique({ where: { id: p.id } });
      expect(row!.status).toBe('DECLINED');
      expect(await ctx.prisma.knowledgeChatRun.count({ where: { sessionId } })).toBe(runsBefore);
      const session = await ctx.prisma.knowledgeChatSession.findUnique({ where: { id: sessionId } });
      expect(session!.pendingSystemMessage).toBe('[system] The user declined your request.');
    });

    it('resolving a proposal of another owner is 404, never 403', async () => {
      // 403 would confirm the id exists. Existence is not leaked (§9.4).
      const res = await asOwner(
        request(ctx.server()).post(
          `/plants/${foreign.plantId}/diagnose/sessions/${foreign.sessionId}/proposals/${foreign.proposalId}/approve`,
        ),
      ).send({});
      expect(res.status).toBe(404);
    });

    it('discloses staleness: after the owner edits the same field, the banner shows live -> proposed', async () => {
      await proposeAndGetPending([{ type: 'frequency.set', task: 'WATER', intervalDays: 5 }]);
      await asOwner(request(ctx.server()).put(`/plants/${plantId}/frequency`)).send({ task: 'WATER', intervalDays: 12 }).expect(200);

      const again = await ownerGet('/proposals/pending').expect(200);
      // All three of §5.5.3's values are on the wire: what the agent saw / what is live / what is proposed.
      expect(again.body.operations[0].changes[0]).toEqual({
        field: 'Every (days)', before: '12', after: '5', stale: { atProposeTime: '7' },
      });
    });

    it('applies all-or-nothing: an entry deleted AFTER propose rolls the whole proposal back', async () => {
      // Atomicity must be proven at APPLY time, so the proposal has to be VALID when filed and become
      // invalid afterwards — the "the world changed in between" case, and the reason validation runs twice.
      const p = await proposeAndGetPending([
        { type: 'frequency.set', task: 'WATER', intervalDays: 5 },
        { type: 'progress.update', entryId, observations: 'x' },
      ]);
      await asOwner(request(ctx.server()).delete(`/plants/${plantId}/progress/${entryId}`)).expect(204);

      await ownerPost(`/proposals/${p.id}/approve`, {});

      const row = await ctx.prisma.doctorWriteProposal.findUnique({ where: { id: p.id } });
      expect(row!.status).toBe('FAILED');
      expect(row!.failureCode).toBeTruthy();
      // NO partial write: the frequency operation must have rolled back with the failing one.
      expect(await ctx.prisma.plantTaskFrequency.count({ where: { plantId, task: 'WATER', intervalDays: 5 } })).toBe(0);
      expect((await ownerGet('/proposals/pending').expect(200)).body).toEqual({});
    });

    it('freezes an omitted occurredOn: proposed on D, approved on D+1, applies D', async () => {
      // Spec 5.2. The owner consented to an entry dated D; approving the next morning must not silently
      // re-date it. Only `Date` is faked — faking timers would stall supertest's own I/O.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        // 14:00 in Mexico City on the 18th — unambiguously D for both the owner and UTC, so this test
        // isolates the FREEZING behaviour rather than re-testing timezone resolution.
        vi.setSystemTime(new Date('2026-07-18T20:00:00.000Z'));
        const p = await proposeAndGetPending([{ type: 'progress.create', health: 'GOOD', observations: 'frozen' }]);

        // The date is already fixed IN THE STORED OPERATION, before anyone approves.
        const stored = await ctx.prisma.doctorWriteProposal.findUnique({ where: { id: p.id } });
        expect(JSON.parse(stored!.operations)[0].occurredOn).toBe('2026-07-18');

        vi.setSystemTime(new Date('2026-07-19T20:00:00.000Z')); // the owner approves the NEXT day
        await ownerPost(`/proposals/${p.id}/approve`, {}).expect(200);

        const entry = await ctx.prisma.plantProgressEntry.findFirst({ where: { plantId, observations: 'frozen' } });
        expect(entry).not.toBeNull();
        expect(entry!.occurredOn.toISOString().slice(0, 10)).toBe('2026-07-18'); // D, not D+1
      } finally {
        vi.useRealTimers();
      }
    });

    it('records origin: an owner-endpoint write is OWNER/null, a proposal-applied write is DOCTOR/<id>', async () => {
      await asOwner(request(ctx.server()).patch(`/plants/${plantId}`)).send({ nickname: 'by-owner' }).expect(200);
      const ownerAudit = await ctx.prisma.plantWriteAudit.findFirst({
        where: { plantId, origin: 'OWNER' }, orderBy: { createdAt: 'desc' },
      });
      expect(ownerAudit).not.toBeNull();
      expect(ownerAudit!.proposalId).toBeNull();

      const p = await proposeAndGetPending([{ type: 'frequency.set', task: 'WATER', intervalDays: 6 }]);
      await ownerPost(`/proposals/${p.id}/approve`, {}).expect(200);

      const doctorAudit = await ctx.prisma.plantWriteAudit.findFirst({ where: { plantId, origin: 'DOCTOR' } });
      expect(doctorAudit).not.toBeNull();
      expect(doctorAudit!.proposalId).toBe(p.id);
    });

    it('exercises each of the eight operation types end-to-end at least once', async () => {
      // A type that parses but has no working applier branch would be invisible to every other test here.
      const cases: { ops: unknown[]; check: () => Promise<void> }[] = [
        {
          ops: [{ type: 'profile.update', potType: 'plastic' }],
          check: async () => expect((await ctx.prisma.plantProfile.findUnique({ where: { plantId } }))!.potType).toBe('plastic'),
        },
        {
          ops: [{ type: 'plant.update', nickname: 'Randy' }],
          check: async () => expect((await ctx.prisma.plant.findUnique({ where: { id: plantId } }))!.nickname).toBe('Randy'),
        },
        {
          ops: [{ type: 'progress.create', health: 'EXCELLENT', observations: 'new leaf' }],
          check: async () => expect(await ctx.prisma.plantProgressEntry.count({ where: { plantId, observations: 'new leaf' } })).toBe(1),
        },
        {
          ops: [{ type: 'progress.update', entryId, observations: 'patched' }],
          check: async () => expect((await ctx.prisma.plantProgressEntry.findUnique({ where: { id: entryId } }))!.observations).toBe('patched'),
        },
        {
          ops: [{ type: 'progress.delete', entryId }],
          check: async () => expect(await ctx.prisma.plantProgressEntry.findUnique({ where: { id: entryId } })).toBeNull(),
        },
        {
          ops: [{ type: 'frequency.set', task: 'MIST', intervalDays: 3 }],
          check: async () => expect(await ctx.prisma.plantTaskFrequency.count({ where: { plantId, task: 'MIST', intervalDays: 3 } })).toBe(1),
        },
        {
          ops: [{ type: 'frequency.clear', task: 'WATER' }],
          check: async () => expect(await ctx.prisma.plantTaskFrequency.count({ where: { plantId, task: 'WATER' } })).toBe(0),
        },
        {
          ops: [{ type: 'care.done', task: 'WATER', occurredOn: '2026-07-18' }],
          check: async () => expect(await ctx.prisma.careEvent.count({ where: { plantId, task: 'WATER', type: 'DONE' } })).toBeGreaterThan(0),
        },
      ];

      for (const [i, c] of cases.entries()) {
        await freshRun();
        const p = await proposeAndGetPending(c.ops);
        const res = await ownerPost(`/proposals/${p.id}/approve`, {});
        expect(res.status, `operation ${i}: ${JSON.stringify(c.ops)}`).toBe(200);
        const row = await ctx.prisma.doctorWriteProposal.findUnique({ where: { id: p.id } });
        expect(row!.status, `operation ${i} failureReason=${row!.failureReason}`).toBe('APPROVED');
        await c.check();
      }
    }, 60_000);
  });

  // ─────────────────────────────── skip permissions ───────────────────────────────

  describe('skip permissions', () => {
    const settings = () => `${base()}/settings`;

    it('is toggled by the owner and by an ADMIN acting-as, and 403s a doctor token on write', async () => {
      expect((await asOwner(request(ctx.server()).patch(settings())).send({ skipPermissions: true })).status).toBe(200);

      const admin = await request(ctx.server())
        .patch(settings())
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Act-As-Owner', ownerId)
        .send({ skipPermissions: false });
      expect(admin.status).toBe(200);

      // An agent that could disable its own supervision is not supervised.
      const doctor = await asDoctor(request(ctx.server()).patch(settings())).send({ skipPermissions: true });
      expect(doctor.status).toBe(403);
    });

    it('is readable by the doctor token via GET settings', async () => {
      const res = await asDoctor(request(ctx.server()).get(settings()));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ skipPermissions: false });
    });

    it('auto-applies immediately and attributes resolvedByUserId to the user who ENABLED it', async () => {
      // The attribution is the point: under an ADMIN acting-as, an anonymous flag would make the
      // auto-approve unauditable.
      await request(ctx.server())
        .patch(settings())
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Act-As-Owner', ownerId)
        .send({ skipPermissions: true })
        .expect(200);
      const enabler = (await ctx.prisma.knowledgeChatSession.findUnique({ where: { id: sessionId } }))!.skipPermissionsSetByUserId;
      expect(enabler).not.toBeNull();

      const res = await propose([{ type: 'frequency.set', task: 'WATER', intervalDays: 4 }]).expect(201);
      expect(res.body.status).toBe('APPROVED');
      expect(res.body.autoApproved).toBe(true);

      // Applied without the owner ever seeing a banner...
      expect(await ctx.prisma.plantTaskFrequency.count({ where: { plantId, task: 'WATER', intervalDays: 4 } })).toBe(1);
      expect((await ownerGet('/proposals/pending').expect(200)).body).toEqual({});
      // ...and attributed to whoever granted the standing consent, not to the agent.
      const row = await ctx.prisma.doctorWriteProposal.findUnique({ where: { id: res.body.id } });
      expect(row!.resolvedByUserId).toBe(enabler);
      // The structured operations and the immutable snapshot are stored even on an auto-apply.
      expect(JSON.parse(row!.operations)[0]).toMatchObject({ type: 'frequency.set', intervalDays: 4 });
      expect(JSON.parse(row!.snapshot)[0]).toEqual({ intervalDays: 7 });
    });
  });
});
