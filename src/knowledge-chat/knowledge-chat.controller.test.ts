import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { KnowledgeChatController } from './knowledge-chat.controller.js';

function setup() {
  const svc = {
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ sessionId: 's1', runId: 'r1', ticket: 'tk' })),
    getSession: vi.fn(async () => ({ id: 's1', turns: [] })),
    resume: vi.fn(async () => ({ runId: 'r2', ticket: 'tk2' })),
    deleteSession: vi.fn(async () => ({ ok: true })),
    getRunLog: vi.fn(async () => 'ndjson'),
    mintSocketTicket: vi.fn(async () => ({ ticket: 'tk3' })),
  };
  const engine = {
    providerStatus: vi.fn(async () => [
      { provider: 'claude', installed: true, authenticated: true, available: true },
    ]),
  };
  return { svc, engine, ctrl: new KnowledgeChatController(svc as any, engine as any) };
}

describe('KnowledgeChatController', () => {
  it('is gated to ADMIN via @Roles metadata', () => {
    const roles = new Reflector().get(ROLES_KEY, KnowledgeChatController);
    expect(roles).toEqual(['ADMIN']);
  });

  it('delegates create → createSession(prompt, provider)', async () => {
    const { svc, ctrl } = setup();
    expect(await ctrl.create({ prompt: 'hi', provider: 'codex' } as any)).toEqual({ sessionId: 's1', runId: 'r1', ticket: 'tk' });
    expect(svc.createSession).toHaveBeenCalledWith('hi', 'codex');
  });

  it('proxies provider-status, and only forces a re-probe when asked', async () => {
    const { engine, ctrl } = setup();
    await ctrl.providerStatus();
    expect(engine.providerStatus).toHaveBeenCalledWith({ force: false });
    await ctrl.providerStatus('1');
    expect(engine.providerStatus).toHaveBeenCalledWith({ force: true });
  });

  it('delegates resume → resume(id, { prompt }, provider?)', async () => {
    const { svc, ctrl } = setup();
    expect(await ctrl.resume('s1', { prompt: 'more' } as any)).toEqual({ runId: 'r2', ticket: 'tk2' });
    expect(svc.resume).toHaveBeenCalledWith('s1', { prompt: 'more' }, undefined);
  });

  it('delegates resume → resume(id, { command }, provider?) for a command turn', async () => {
    const { svc, ctrl } = setup();
    const dto = { command: { name: 'compact', args: '' } } as any;
    expect(await ctrl.resume('s1', dto)).toEqual({ runId: 'r2', ticket: 'tk2' });
    expect(svc.resume).toHaveBeenCalledWith('s1', { command: { name: 'compact', args: '' } }, undefined);
  });

  it('400s when a run body carries BOTH prompt and command', () => {
    const { ctrl } = setup();
    expect(() => ctrl.resume('s1', { prompt: 'x', command: { name: 'compact', args: '' } } as any))
      .toThrow(BadRequestException);
  });

  it('400s when a run body carries NEITHER prompt nor command', () => {
    const { ctrl } = setup();
    expect(() => ctrl.resume('s1', {} as any)).toThrow(BadRequestException);
  });

  it('delegates list/detail/delete/log/ticket', async () => {
    const { svc, ctrl } = setup();
    await ctrl.list();
    await ctrl.detail('s1');
    await ctrl.remove('s1');
    await ctrl.log('r1');
    await ctrl.socketTicket('r1');
    expect(svc.listSessions).toHaveBeenCalled();
    expect(svc.getSession).toHaveBeenCalledWith('s1');
    expect(svc.deleteSession).toHaveBeenCalledWith('s1');
    expect(svc.getRunLog).toHaveBeenCalledWith('r1');
    expect(svc.mintSocketTicket).toHaveBeenCalledWith('r1');
  });
});
