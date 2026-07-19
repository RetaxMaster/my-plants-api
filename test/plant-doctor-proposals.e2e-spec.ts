import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
