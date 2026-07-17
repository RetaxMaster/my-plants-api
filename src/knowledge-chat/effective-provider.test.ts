import { describe, expect, it } from 'vitest';
import { resolveEffectiveProvider } from './effective-provider.js';

describe('resolveEffectiveProvider', () => {
  it('create → returns the request provider', () => {
    expect(
      resolveEffectiveProvider({ isCreate: true, sealed: false, requestProvider: 'claude' }),
    ).toBe('claude');
  });

  it('sealed session → returns session.provider and IGNORES the request provider', () => {
    // A resume of a sealed codex session must never be swayed by a spoofed/omitted request provider.
    expect(
      resolveEffectiveProvider({
        isCreate: false,
        sealed: true,
        sessionProvider: 'codex',
        requestProvider: 'claude',
      }),
    ).toBe('codex');
  });

  it('unsealed non-create, request present → request wins', () => {
    expect(
      resolveEffectiveProvider({
        isCreate: false,
        sealed: false,
        sessionProvider: 'codex',
        requestProvider: 'claude',
      }),
    ).toBe('claude');
  });

  it('unsealed non-create, request undefined → falls back to session.provider', () => {
    expect(
      resolveEffectiveProvider({ isCreate: false, sealed: false, sessionProvider: 'codex' }),
    ).toBe('codex');
  });
});
