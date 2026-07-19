import { describe, it, expect } from 'vitest';
import { SYSTEM_MARKER, SYSTEM_MESSAGE } from './system-message.js';

/**
 * These strings are a WIRE CONTRACT, not copy. Three separate consumers match on them: the doctor
 * agent's operator guide tells it how to read a `[system]` line, the API's own delivery path detects an
 * undelivered message, and the web renders the marker distinctly from an owner-typed line. None of them
 * can see this file, so the values are pinned literally here — a "harmless" rewording is a silent
 * cross-repo break, and this test is where it surfaces.
 */
describe('system messages', () => {
  it('pins the exact wire values', () => {
    expect(SYSTEM_MARKER).toBe('[system]');
    expect(SYSTEM_MESSAGE.declined).toBe('[system] The user declined your request.');
    expect(SYSTEM_MESSAGE.notApproved).toBe('[system] The user still has not approved the request.');
    expect(SYSTEM_MESSAGE.failed('nope')).toBe('[system] Your request could not be applied: nope');
  });

  it('prefixes every message with the marker, including the templated one', () => {
    // The marker is what makes a line identifiable as not-written-by-the-human. A message that lost it
    // would read to the agent — and to the owner — as if the owner had typed it.
    const all = [SYSTEM_MESSAGE.declined, SYSTEM_MESSAGE.notApproved, SYSTEM_MESSAGE.failed('any reason')];
    for (const message of all) expect(message.startsWith(`${SYSTEM_MARKER} `)).toBe(true);
  });

  it('carries the sanitized failure reason verbatim, and nothing else', () => {
    // The reason always arrives from classifyFailure(), which is the only place sanitizing happens.
    // This template must not re-wrap, truncate or reformat it, or the agent and the owner would be
    // shown two different explanations of the same failure.
    const reason = 'One of the requested changes was not valid for this plant.';
    expect(SYSTEM_MESSAGE.failed(reason)).toBe(`${SYSTEM_MARKER} Your request could not be applied: ${reason}`);
  });
});
