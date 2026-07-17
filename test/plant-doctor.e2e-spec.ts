import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { WeatherService } from '../src/weather/weather.service.js';
import { ImageUploadService } from '../src/storage/image-upload.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KNOWLEDGE_ENGINE, DOCTOR_ENGINE, DOCTOR_ORCHESTRATOR } from '../src/knowledge-chat/engine/engine-params.js';
import type { KnowledgeChatOrchestrator } from '../src/knowledge-chat/engine/knowledge-chat-orchestrator.js';

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

  const executeCalls: { kind: string; runId: string; env?: Record<string, string> }[] = [];
  const makeFakeEngine = (kind: string) => ({
    logDir: mkdtempSync(join(tmpdir(), `pd-e2e-${kind}-`)),
    execute: async (req: { runId: string; logPath: string; env?: Record<string, string> }) => {
      executeCalls.push({ kind, runId: req.runId, env: req.env });
      await mkdir(dirname(req.logPath), { recursive: true });
      await writeFile(req.logPath, `{"type":"log.header","schemaVersion":"1.0.0","runId":"${req.runId}"}\n`, { flag: 'wx' });
    },
    providerStatus: async () => [
      { provider: 'claude', installed: true, authenticated: true, available: true },
      { provider: 'codex', installed: true, authenticated: true, available: true },
    ],
    commandCatalog: async () => ({ provider: 'claude', commands: [] }),
    loadHistory: async () => ({ provider: 'claude', providerSessionId: 'x', turns: [] }),
    onModuleInit: async () => {},
    onModuleDestroy: async () => {},
    get isRunning() { return false; },
  });
  const fakeKnowledge = makeFakeEngine('KNOWLEDGE');
  const fakeDoctor = makeFakeEngine('DOCTOR');
  const fakeImages = { upload: async () => ({ imageUrl: 'https://cdn.test/x.webp', imageObjectKey: 'k/x.webp' }), delete: async () => {} };

  const password = 'e2e-secret';
  const n1 = `e2e-pd-o1-${randomUUID()}`;
  const n2 = `e2e-pd-o2-${randomUUID()}`;
  let owner1Id: string; let user1Id: string; let user1Username: string;
  let owner2Id: string; let user2Id: string;
  let token1: string; let token2: string;
  let plantA: string; let plantA2: string; let plantB: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WeatherService).useValue({ forLocation: async () => null, forCity: async () => null })
      .overrideProvider(ImageUploadService).useValue(fakeImages)
      .overrideProvider(KNOWLEDGE_ENGINE).useValue(fakeKnowledge)
      .overrideProvider(DOCTOR_ENGINE).useValue(fakeDoctor)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    doctorOrch = app.get<KnowledgeChatOrchestrator>(DOCTOR_ORCHESTRATOR);

    const server = app.getHttpServer();
    const mkOwner = async (name: string, role: 'USER' | 'ADMIN' = 'USER') => {
      const owner = await prisma.owner.create({ data: { name } });
      const user = await prisma.user.create({ data: { username: name, passwordHash: await bcrypt.hash(password, 10), role, ownerId: owner.id } });
      const token = (await request(server).post('/auth/login').send({ username: name, password }).expect(201)).body.token;
      return { ownerId: owner.id, userId: user.id, token };
    };
    ({ ownerId: owner1Id, userId: user1Id, token: token1 } = await mkOwner(n1));
    user1Username = n1;
    ({ ownerId: owner2Id, userId: user2Id, token: token2 } = await mkOwner(n2));

    const slug = (await request(server).get('/species').expect(200)).body[0].slug as string;
    const mkPlant = async (token: string, label: string) => {
      const as = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
      const city = await as(request(server).post('/cities')).send({ name: `${label} City`, latitude: 19.43, longitude: -99.13, timezone: 'America/Mexico_City', isPrimary: true }).expect(201);
      const place = await as(request(server).post('/places')).send({ cityId: city.body.id, name: `${label} Room`, indoor: true, lightType: 'BRIGHT_INDIRECT' }).expect(201);
      const plant = await as(request(server).post('/plants')).send({ placeId: place.body.id, speciesSlug: slug, acquiredOn: '2020-01-01' }).expect(201);
      return plant.body.id as string;
    };
    plantA = await mkPlant(token1, 'A');
    plantA2 = await mkPlant(token1, 'A2');
    plantB = await mkPlant(token2, 'B');
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.knowledgeChatSession.deleteMany({ where: { ownerId: { in: [owner1Id, owner2Id] } } });
      for (const oid of [owner1Id, owner2Id]) {
        await prisma.knowledgeChatSession.deleteMany({ where: { plant: { ownerId: oid } } });
        await prisma.plantTaskFrequency.deleteMany({ where: { plant: { ownerId: oid } } });
        await prisma.dueCache.deleteMany({ where: { plant: { ownerId: oid } } });
        await prisma.plantProfile.deleteMany({ where: { plant: { ownerId: oid } } });
        await prisma.plant.deleteMany({ where: { ownerId: oid } });
        await prisma.place.deleteMany({ where: { ownerId: oid } });
        await prisma.city.deleteMany({ where: { ownerId: oid } });
      }
      await prisma.user.deleteMany({ where: { id: { in: [user1Id, user2Id] } } });
      await prisma.owner.deleteMany({ where: { id: { in: [owner1Id, owner2Id] } } });
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
      docTokenA = await app.get(AuthService).mintDoctorToken({ userId: user1Id, username: user1Username, ownerId: owner1Id, plantId: plantA });
      expect(docTokenA).toBeTruthy();
    });

    it('ACCEPTS allowlisted plant-A endpoints (care + frequency)', async () => {
      await asDoc(request(server()).get(`/plants/${plantA}/care`)).expect(200);
      await asDoc(request(server()).put(`/plants/${plantA}/frequency`)).send({ task: 'WATER', intervalDays: 7 }).expect(200);
      await asDoc(request(server()).delete(`/plants/${plantA}/frequency/WATER`)).expect(200);
    });

    it('REJECTS (403) the same allowlisted endpoints for a DIFFERENT plant (the pin)', async () => {
      await asDoc(request(server()).get(`/plants/${plantB}/care`)).expect(403);
      await asDoc(request(server()).put(`/plants/${plantB}/frequency`)).send({ task: 'WATER', intervalDays: 7 }).expect(403);
    });

    it('REJECTS (403) a non-allowlisted endpoint even for plant A (default-deny narrows, never widens)', async () => {
      await asDoc(request(server()).get(`/plants/${plantA}`)).expect(403);
      await asDoc(request(server()).get(`/plants/${plantA}/diagnose/sessions`)).expect(403);
    });

    it('a NORMAL owner token is unaffected on a non-allowlisted route', async () => {
      await as1(request(server()).get(`/plants/${plantA}`)).expect(200);
    });
  });

  it('finalizing the run through the REAL orchestrator unblocks delete, which sweeps the session', async () => {
    await doctorOrch.runStarted(runA, { pid: 4242, procStartTime: '1', sessionId: 'uuid-doc-abc' });
    await doctorOrch.runFinished(runA, { exitCode: 0, stopped: false, stderrTail: null });
    await as1(request(server()).delete(`/plants/${plantA}/diagnose/sessions/${sidA}`)).expect(200);
    await as1(request(server()).get(`/plants/${plantA}/diagnose/sessions/${sidA}`)).expect(404);
  });
});
