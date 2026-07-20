import { describe, it, expect } from 'vitest';
import { SYSTEM_MESSAGE } from './system-message.js';

/**
 * These strings are a WIRE CONTRACT, not copy. Three separate consumers match on them: the doctor agent's
 * operator guide, the API's own delivery path, and the web's rendering. None of them can see this file, so
 * the values are pinned literally here — a "harmless" rewording is a silent cross-repo break, and this test
 * is where it surfaces.
 */
describe('system messages', () => {
  it('pins the exact wire values, with no marker prefix', () => {
    expect(SYSTEM_MESSAGE.declined).toBe('The user declined your request.');
    expect(SYSTEM_MESSAGE.notApproved).toBe('The user still has not approved the request.');
    expect(SYSTEM_MESSAGE.failed('nope')).toBe('Your request could not be applied: nope');
  });

  it('carries no `[system]` marker anywhere — the structural frame replaced it', () => {
    // The marker existed only because these messages used to render as if the owner had typed them. The
    // package's `<agents-rt:system-message>` frame now carries that signal structurally, and its
    // instruction block teaches the agent that the frame carries host authority. Keeping the marker would
    // mean adopting the native mechanism AND retaining the workaround it replaces.
    const all = [SYSTEM_MESSAGE.declined, SYSTEM_MESSAGE.notApproved, SYSTEM_MESSAGE.failed('any reason')];
    for (const message of all) expect(message).not.toContain('[system]');
  });

  it('carries the sanitized failure reason verbatim, and nothing else', () => {
    // The reason always arrives from classifyFailure(), which is the only place sanitizing happens. This
    // template must not re-wrap, truncate or reformat it, or the agent and the owner would be shown two
    // different explanations of the same failure.
    const reason = 'One of the requested changes was not valid for this plant.';
    expect(SYSTEM_MESSAGE.failed(reason)).toBe(`Your request could not be applied: ${reason}`);
  });
});
