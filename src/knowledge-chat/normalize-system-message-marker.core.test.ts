import { describe, it, expect, vi } from 'vitest';
import { normalizeMarkerColumns, assertSurveyRanFirst } from './normalize-system-message-marker.core.js';

describe('the DB marker normalisation (spec 3.5)', () => {
  it('strips the prefix from BOTH columns', async () => {
    const updates: Array<{ table: string; from: string; to: string }> = [];
    await normalizeMarkerColumns({
      loadRuns: async () => [{ id: 'r1', systemMessageText: '[system] The user declined your request.' }],
      loadSessions: async () => [{ id: 's1', pendingSystemMessage: '[system] The user still has not approved the request.' }],
      updateRun: async (id, to) => updates.push({ table: 'run', from: id, to }),
      updateSessionIfUnchanged: async (id, _from, to) => {
        updates.push({ table: 'session', from: id, to });
        return true;
      },
      surveyCompleted: true,
    });
    expect(updates).toEqual([
      { table: 'run', from: 'r1', to: 'The user declined your request.' },
      { table: 'session', from: 's1', to: 'The user still has not approved the request.' },
    ]);
  });

  // NOT the same test as above, on purpose. A version that only feeds an already-normalised value and
  // asserts "never called" cannot distinguish "correctly detected already-normalised" from "unconditionally
  // never writes" — a mutant that makes the skip-if-unchanged check unconditional passes that shape happily,
  // and it is killed only by the write-path test above, which is testing something else entirely. Feeding
  // BOTH a marked and an already-normalised row in the SAME call is the shape that actually pins the
  // property: the marked row must be written exactly once, and the clean row must trigger no call at all.
  it('updates exactly the marked rows and never touches an already-normalised one (idempotent)', async () => {
    const updateRun = vi.fn(async () => {});
    const updateSessionIfUnchanged = vi.fn(async () => true);
    const result = await normalizeMarkerColumns({
      loadRuns: async () => [
        { id: 'r-marked', systemMessageText: '[system] The user declined your request.' },
        { id: 'r-clean', systemMessageText: 'Already normalised text.' },
      ],
      loadSessions: async () => [
        { id: 's-marked', pendingSystemMessage: '[system] The user still has not approved the request.' },
        { id: 's-clean', pendingSystemMessage: 'Already normalised text.' },
      ],
      updateRun,
      updateSessionIfUnchanged,
      surveyCompleted: true,
    });

    expect(updateRun).toHaveBeenCalledTimes(1);
    expect(updateRun).toHaveBeenCalledWith('r-marked', 'The user declined your request.');
    expect(updateSessionIfUnchanged).toHaveBeenCalledTimes(1);
    expect(updateSessionIfUnchanged).toHaveBeenCalledWith(
      's-marked',
      '[system] The user still has not approved the request.',
      'The user still has not approved the request.',
    );
    expect(result.runsUpdated).toBe(1);
    expect(result.sessionsUpdated).toBe(1);
  });

  it('REFUSES TO RUN before the log survey — normalising first destroys the recognizer authority', async () => {
    // The recognizer uses systemMessageText as its MATCHING AUTHORITY. Normalising beforehand would be the
    // difference between a successful promotion and a silent no-op, so this must be impossible, not merely
    // documented. The ordering is NOT made vacuous by the expected-zero yield: the survey still READS the column.
    expect(() => assertSurveyRanFirst({ surveyCompleted: false })).toThrow(/survey/i);
    expect(() => assertSurveyRanFirst({ surveyCompleted: true })).not.toThrow();
  });

  it('fails the run rather than silently proceeding when the ordering flag is absent', async () => {
    await expect(normalizeMarkerColumns({
      loadRuns: async () => [], loadSessions: async () => [],
      updateRun: vi.fn(), updateSessionIfUnchanged: vi.fn(async () => true), surveyCompleted: false,
    })).rejects.toThrow(/survey/i);
  });

  it('counts a lost CAS race as a named skip — never a crash, never a silent success', async () => {
    const onSessionSkipped = vi.fn();
    const updateSessionIfUnchanged = vi.fn(async () => false); // the slot changed underneath us
    const result = await normalizeMarkerColumns({
      loadRuns: async () => [],
      loadSessions: async () => [{ id: 's1', pendingSystemMessage: '[system] The user still has not approved the request.' }],
      updateRun: vi.fn(),
      updateSessionIfUnchanged,
      surveyCompleted: true,
      onSessionSkipped,
    });

    expect(updateSessionIfUnchanged).toHaveBeenCalledWith(
      's1',
      '[system] The user still has not approved the request.',
      'The user still has not approved the request.',
    );
    expect(result.sessionsUpdated).toBe(0);
    expect(result.sessionsSkipped).toEqual([{ id: 's1', reason: expect.stringMatching(/changed|concurrent|race/i) }]);
    expect(onSessionSkipped).toHaveBeenCalledWith('s1', expect.stringMatching(/changed|concurrent|race/i));
  });
});
