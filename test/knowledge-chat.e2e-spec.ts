import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { WeatherService } from '../src/weather/weather.service.js';
import { KnowledgeChatEngineService } from '../src/knowledge-chat/engine/knowledge-chat-engine.service.js';
import { KnowledgeChatOrchestrator } from '../src/knowledge-chat/engine/knowledge-chat-orchestrator.js';

// End-to-end for the admin knowledge-chat HTTP surface over the REAL stack (global JwtAuthGuard →
// controller-scoped RolesGuard → service → Prisma → DB), against a running MariaDB.
//
// HERMETIC: the embedded engine is FAKED — its execute() is a no-op, so no `claude` is ever spawned
// and no port is bound (KNOWLEDGE_CHAT_ENGINE_ENABLED=false via the e2e config). We drive terminal
// transitions through the REAL orchestrator (runStarted/runFinished), the same seam the live engine
// uses — never by hand-forcing DB rows. WeatherService is stubbed only so the startup recompute at
// boot doesn't hit the network.
describe('Knowledge Chat (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orchestrator: KnowledgeChatOrchestrator;
  const executeCalls: { runId: string; logPath: string; prompt?: string; command?: { name: string; args: string } }[] = [];
  const fakeEngine = {
    // The double honors the ONE side effect the real engine has at this seam: it CREATES the run's log
    // itself (O_CREAT|O_EXCL) and writes the header before streaming — the host never pre-creates it. Without
    // that, `GET /runs/:id/log` has no file to serve and the endpoint looks broken when it is not.
    execute: async (req: { runId: string; logPath: string }) => {
      executeCalls.push(req);
      await mkdir(dirname(req.logPath), { recursive: true });
      await writeFile(req.logPath, `{"type":"log.header","schemaVersion":"1.0.0","runId":"${req.runId}"}\n`, { flag: 'wx' });
    },
    onModuleInit: async () => {},
    onModuleDestroy: async () => {},
    get isRunning() { return false; },
  };

  const adminName = `e2e-kc-admin-${randomUUID()}`;
  const userName = `e2e-kc-user-${randomUUID()}`;
  const password = 'e2e-secret';
  let adminOwnerId: string;
  let adminUserId: string;
  let userOwnerId: string;
  let userUserId: string;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WeatherService).useValue({ forLocation: async () => null, forCity: async () => null })
      .overrideProvider(KnowledgeChatEngineService).useValue(fakeEngine)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); // mirror main.ts
    await app.init();

    prisma = app.get(PrismaService);
    orchestrator = app.get(KnowledgeChatOrchestrator);

    const adminOwner = await prisma.owner.create({ data: { name: adminName } });
    adminOwnerId = adminOwner.id;
    const admin = await prisma.user.create({
      data: { username: adminName, passwordHash: await bcrypt.hash(password, 10), role: 'ADMIN', ownerId: adminOwnerId },
    });
    adminUserId = admin.id;

    const userOwner = await prisma.owner.create({ data: { name: userName } });
    userOwnerId = userOwner.id;
    const user = await prisma.user.create({
      data: { username: userName, passwordHash: await bcrypt.hash(password, 10), role: 'USER', ownerId: userOwnerId },
    });
    userUserId = user.id;

    adminToken = (await request(app.getHttpServer()).post('/auth/login').send({ username: adminName, password }).expect(201)).body.token;
    userToken = (await request(app.getHttpServer()).post('/auth/login').send({ username: userName, password }).expect(201)).body.token;
  });

  afterAll(async () => {
    if (prisma) {
      // Cascade removes runs + tickets; then remove the seeded users/owners.
      await prisma.knowledgeChatSession.deleteMany({ where: { createdByUserId: { in: [adminUserId, userUserId] } } });
      await prisma.user.deleteMany({ where: { id: { in: [adminUserId, userUserId] } } });
      await prisma.owner.deleteMany({ where: { id: { in: [adminOwnerId, userOwnerId] } } });
    }
    if (app) await app.close();
  });

  const asAdmin = (req: request.Test) => req.set('Authorization', `Bearer ${adminToken}`);
  const asUser = (req: request.Test) => req.set('Authorization', `Bearer ${userToken}`);
  const server = () => app.getHttpServer();

  let sessionId: string;
  let runId: string;

  it('rejects a non-admin with 403 (controller-scoped RolesGuard after the global JwtAuthGuard)', async () => {
    await asUser(request(server()).get('/knowledge-chat/sessions')).expect(403);
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(server()).get('/knowledge-chat/sessions').expect(401);
  });

  it('POST /sessions creates a session + first active run, mints a ticket, and calls /execute', async () => {
    // `provider` is REQUIRED: since agents-realtime 1.0.0 the engine spawns a provider-neutral runner and
    // cannot guess which agent to drive. (This spec omitted it and had been failing 400 ever since — silently,
    // because the e2e suite runs under its own config and is not part of `npm test`.)
    const res = await asAdmin(request(server()).post('/knowledge-chat/sessions'))
      .send({ prompt: 'Research Monstera deliciosa care', provider: 'claude' })
      .expect(201);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.runId).toBeTruthy();
    expect(res.body.ticket).toBeTruthy();
    sessionId = res.body.sessionId;
    runId = res.body.runId;
    // The agent travels on every /execute — and a prompt turn carries NO command.
    expect(executeCalls.at(-1)).toMatchObject({ runId, provider: 'claude', resumeSessionId: null });
    expect(executeCalls.at(-1)).toHaveProperty('prompt', 'Research Monstera deliciosa care');
    expect(executeCalls.at(-1)?.command).toBeUndefined();
  });

  it('GET /sessions lists it newest-first with the latest-run status + turns count', async () => {
    const res = await asAdmin(request(server()).get('/knowledge-chat/sessions')).expect(200);
    const mine = res.body.find((s: { id: string }) => s.id === sessionId);
    expect(mine).toMatchObject({ id: sessionId, title: 'Research Monstera deliciosa care', status: 'QUEUED', turns: 1 });
  });

  it('GET /sessions/:id returns ordered turns with isActive + logUrl', async () => {
    const res = await asAdmin(request(server()).get(`/knowledge-chat/sessions/${sessionId}`)).expect(200);
    // Renamed in the agents-realtime 1.0.0 migration: with two agents, `claudeSessionId` was a lie for half
    // the rows. This assertion still read the old name — so it asserted `undefined === null` and passed by
    // accident once the request above started 400ing.
    expect(res.body.providerSessionId).toBeNull();
    expect(res.body.turns[0]).toEqual({ runId, prompt: 'Research Monstera deliciosa care', command: null, status: 'QUEUED', isActive: true, logUrl: `/knowledge-chat/runs/${runId}/log` });
  });

  // The 422 this test used to assert ("the session has no Claude session id yet") DIED with agents-realtime
  // 1.0.0: a conversation whose opening turn never reached an agent is no longer a dead end — it is RETRIED,
  // possibly on the other agent. What actually blocks a second send here is the single-active-run rule, and
  // that is a 409.
  it('POST /sessions/:id/runs → 409 while a run is already active', async () => {
    await asAdmin(request(server()).post(`/knowledge-chat/sessions/${sessionId}/runs`)).send({ prompt: 'follow-up' }).expect(409);
  });

  it('POST /sessions/:id/runs → 400 when the body carries both a prompt AND a command', async () => {
    // Exactly one, or it is not a turn. The engine answers the same 400 — we decide it here so a malformed
    // body never reaches it wearing a valid shape.
    await asAdmin(request(server()).post(`/knowledge-chat/sessions/${sessionId}/runs`))
      .send({ prompt: 'hi', command: { name: 'compact', args: '' } })
      .expect(400);
  });

  it('POST /sessions/:id/runs → 422 for a COMMAND on a conversation with no agent session', async () => {
    // A command acts on a live agent session: there is nothing to compact and no session whose model to
    // switch. Refused before any run is created — note it beats the 409 above, which is why it is reachable
    // while the opening run is still active.
    await asAdmin(request(server()).post(`/knowledge-chat/sessions/${sessionId}/runs`))
      .send({ command: { name: 'compact', args: '' } })
      .expect(422);
  });

  it('DELETE /sessions/:id → 409 while a run is active', async () => {
    await asAdmin(request(server()).delete(`/knowledge-chat/sessions/${sessionId}`)).expect(409);
  });

  it('POST /runs/:runId/socket-ticket mints a fresh ticket', async () => {
    const res = await asAdmin(request(server()).post(`/knowledge-chat/runs/${runId}/socket-ticket`)).expect(201);
    expect(res.body.ticket).toBeTruthy();
  });

  it('GET /runs/:runId/log serves the raw (host-truncated) transcript as text/plain', async () => {
    const res = await asAdmin(request(server()).get(`/knowledge-chat/runs/${runId}/log`)).expect(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('after the run finishes (real orchestrator terminal path), resume works and delete succeeds', async () => {
    // Drive the REAL seams the live engine would call: capture the UUID, then finalize the run.
    await orchestrator.runStarted(runId, { pid: 4242, procStartTime: '1', sessionId: 'uuid-e2e-abc' });
    await orchestrator.runFinished(runId, { exitCode: 0, stopped: false, stderrTail: null });

    // Now resumable (claudeSessionId set) and the active slot is freed.
    const resume = await asAdmin(request(server()).post(`/knowledge-chat/sessions/${sessionId}/runs`)).send({ prompt: 'And watering?' }).expect(201);
    expect(executeCalls.at(-1)).toMatchObject({ runId: resume.body.runId, resumeSessionId: 'uuid-e2e-abc' });

    // Finalize the resume run too so delete is unblocked.
    await orchestrator.runFinished(resume.body.runId, { exitCode: 0, stopped: false, stderrTail: null });

    // NOW a command is legal: the conversation has an agent session for it to act on. It must reach /execute
    // in its OWN field, with NO prompt — that mutual exclusion is the whole contract. And the run row must
    // record it as a command, not as the text "/compact".
    const cmd = await asAdmin(request(server()).post(`/knowledge-chat/sessions/${sessionId}/runs`))
      .send({ command: { name: 'compact', args: '' } })
      .expect(201);
    const sent = executeCalls.at(-1)!;
    expect(sent).toMatchObject({ runId: cmd.body.runId, command: { name: 'compact', args: '' }, resumeSessionId: 'uuid-e2e-abc' });
    expect(sent.prompt).toBeUndefined();
    const cmdRun = await prisma.knowledgeChatRun.findUnique({ where: { id: cmd.body.runId } });
    expect(cmdRun).toMatchObject({ prompt: null, commandName: 'compact', commandArgs: '' });
    await orchestrator.runFinished(cmd.body.runId, { exitCode: 0, stopped: false, stderrTail: null });
    await asAdmin(request(server()).delete(`/knowledge-chat/sessions/${sessionId}`)).expect(200);
    await asAdmin(request(server()).get(`/knowledge-chat/sessions/${sessionId}`)).expect(404);
  });
});
