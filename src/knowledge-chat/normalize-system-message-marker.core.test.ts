import { describe, it, expect, vi } from 'vitest';
import { normalizeMarkerColumns, assertSurveyRanFirst } from './normalize-system-message-marker.core.js';

describe('the DB marker normalisation (spec 3.5)', () => {
  it('strips the prefix from BOTH columns', async () => {
    const updates: Array<{ table: string; from: string; to: string }> = [];
    await normalizeMarkerColumns({
      loadRuns: async () => [{ id: 'r1', systemMessageText: '[system] The user declined your request.' }],
      loadSessions: async () => [{ id: 's1', pendingSystemMessage: '[system] The user still has not approved the request.' }],
      updateRun: async (id, to) => updates.push({ table: 'run', from: id, to }),
      updateSession: async (id, to) => updates.push({ table: 'session', from: id, to }),
      surveyCompleted: true,
    });
    expect(updates).toEqual([
      { table: 'run', from: 'r1', to: 'The user declined your request.' },
      { table: 'session', from: 's1', to: 'The user still has not approved the request.' },
    ]);
  });

  it('leaves an already-normalised value untouched (idempotent)', async () => {
    const updateRun = vi.fn();
    await normalizeMarkerColumns({
      loadRuns: async () => [{ id: 'r1', systemMessageText: 'The user declined your request.' }],
      loadSessions: async () => [], updateRun, updateSession: vi.fn(), surveyCompleted: true,
    });
    expect(updateRun).not.toHaveBeenCalled();
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
      updateRun: vi.fn(), updateSession: vi.fn(), surveyCompleted: false,
    })).rejects.toThrow(/survey/i);
  });
});
