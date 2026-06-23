import { describe, expect, it } from 'vitest';
import { AuthController } from './auth.controller.js';

describe('AuthController.me', () => {
  const ctrl = new AuthController({} as any);

  it('reports actingAs: null when not impersonating', () => {
    const req = { user: { username: 'carlos', role: 'USER' } } as any;
    expect(ctrl.me(req)).toEqual({ username: 'carlos', role: 'USER', actingAs: null });
  });

  it('reports the acting-as ownerId when impersonating', () => {
    const req = { user: { username: 'root', role: 'ADMIN', actingAsOwnerId: 'oTarget' } } as any;
    expect(ctrl.me(req)).toEqual({ username: 'root', role: 'ADMIN', actingAs: { ownerId: 'oTarget' } });
  });
});
