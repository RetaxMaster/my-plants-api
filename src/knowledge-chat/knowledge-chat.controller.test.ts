import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
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
  return { svc, ctrl: new KnowledgeChatController(svc as any) };
}

describe('KnowledgeChatController', () => {
  it('is gated to ADMIN via @Roles metadata', () => {
    const roles = new Reflector().get(ROLES_KEY, KnowledgeChatController);
    expect(roles).toEqual(['ADMIN']);
  });

  it('delegates create → createSession(prompt)', async () => {
    const { svc, ctrl } = setup();
    expect(await ctrl.create({ prompt: 'hi' } as any)).toEqual({ sessionId: 's1', runId: 'r1', ticket: 'tk' });
    expect(svc.createSession).toHaveBeenCalledWith('hi');
  });

  it('delegates resume → resume(id, prompt)', async () => {
    const { svc, ctrl } = setup();
    expect(await ctrl.resume('s1', { prompt: 'more' } as any)).toEqual({ runId: 'r2', ticket: 'tk2' });
    expect(svc.resume).toHaveBeenCalledWith('s1', 'more');
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
