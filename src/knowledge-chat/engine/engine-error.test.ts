import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapEngineFailure, PREFIX_RULES } from './engine-error.js';

// EVERY ENGINE STRING BELOW IS THE REAL ONE, read off the installed
// `@retaxmaster/agents-realtime-server@3.0.0` rather than invented. That is not pedantry: the plan's
// original fixtures shared invented prose with the rules they tested, so three rules that match NOTHING
// the engine ever emits ("attachments are not configured", "attachment content does not match",
// "turn.input event too large") would have passed every assertion here while silently degrading a
// nameable failure to a neutral code in production. A prefix rule can only be proven by prose the engine
// actually produces.
describe('mapEngineFailure (spec §7)', () => {
  // The prefix match must be exercised WITHIN a status, not only across statuses — one case per status
  // would verify only the status half and never the discrimination this mapping exists for.
  it('discriminates two DIFFERENT 422 failures into two DIFFERENT codes', () => {
    expect(mapEngineFailure(422, { error: "attachments require the engine's `uploadRoot` to be configured" }).code)
      .toBe('attachments_unavailable');
    expect(mapEngineFailure(422, { error: 'attachment write failed', detail: '/srv/x' }).code)
      .toBe('attachment_write_failed');
  });

  it('discriminates BOTH 413 codes', () => {
    expect(mapEngineFailure(413, { error: 'attachment exceeds the per-file limit of 10485760 bytes' }).code)
      .toBe('attachment_too_large');
    // The OTHER real 413 attachment string — the total cap. Both must land on the same code.
    expect(mapEngineFailure(413, { error: 'attachments exceed the total limit of 20971520 bytes' }).code)
      .toBe('attachment_too_large');
    expect(mapEngineFailure(413, { error: 'composed prompt too large', maxBytes: 1, actualBytes: 2 }).code)
      .toBe('message_too_long');
  });

  it('maps a magic-byte / MIME mismatch to attachment_corrupt', () => {
    expect(mapEngineFailure(422, { error: 'attachment mimeType is not an allowed image type: image/png' }).code)
      .toBe('attachment_corrupt');
  });

  it('maps an oversized turn input to message_too_long', () => {
    // The engine says "turn input too large" — NOT "turn.input event too large". The invented spelling
    // would have fallen through the 413 rules entirely (it does not start with "attachment") and degraded
    // to the neutral payload_too_large.
    expect(mapEngineFailure(413, { error: 'turn input too large', maxBytes: 1, actualBytes: 2 }).code)
      .toBe('message_too_long');
  });

  it('maps a magic-byte mismatch to attachment_corrupt using the string the engine really emits', () => {
    expect(mapEngineFailure(422, { error: 'attachment bytes do not match the declared mimeType (image/png)' }).code)
      .toBe('attachment_corrupt');
  });

  it('maps the engine own body-parser refusal to payload_too_large (the drift alarm)', () => {
    expect(
      mapEngineFailure(413, {
        error: 'request body too large',
        limitBytes: 33554432,
        detail: "The request body exceeded the engine's configured JSON body limit",
      }).code,
    ).toBe('payload_too_large');
  });

  it('falls back to a NEUTRAL code on 413, never a sibling', () => {
    // attachment_too_large would tell an owner whose composed prompt overflowed — a path carrying ZERO
    // attachments — that their images are too large.
    expect(mapEngineFailure(413, { error: 'something upstream reworded this message entirely' }).code)
      .toBe('payload_too_large');
  });

  it('falls back to a NEUTRAL code on 422, never a sibling', () => {
    // 422 is not attachment-specific and predates attachments: `invalid payload` and `run rejected` both
    // fire on turns with ZERO attachments. attachment_failed would name something the user did not do.
    expect(mapEngineFailure(422, { error: 'invalid payload' }).code).toBe('request_failed');
  });

  it('degrades an UNMAPPED status to request_failed rather than throwing', () => {
    expect(mapEngineFailure(400, { error: 'one of prompt, systemMessage or command is required' }).code)
      .toBe('request_failed');
    expect(mapEngineFailure(503, { error: 'engine draining' }).code).toBe('request_failed');
    expect(mapEngineFailure(418, {}).code).toBe('request_failed');
  });

  it('NEVER leaks the engine prose or an absolute server path to the client', () => {
    // `detail` is a raw Error.message that can contain absolute server paths, and the event-stream
    // redaction does NOT touch these HTTP bodies. Dropping every non-status field covers `detail` and the
    // 413s' numeric fields under one rule.
    const out = mapEngineFailure(422, {
      error: 'attachment path rejected',
      detail: '/srv/myplants/apps/my-plants/storage/plant-doctor-uploads/x.png',
    });
    expect(JSON.stringify(out)).not.toContain('/srv/');
    expect(JSON.stringify(out)).not.toContain('attachment path rejected');
    expect(out).toEqual({ code: 'attachment_write_failed', status: 422 });
  });

  it('never throws on a malformed or empty body', () => {
    expect(() => mapEngineFailure(422, undefined)).not.toThrow();
    expect(() => mapEngineFailure(413, 'not json')).not.toThrow();
  });
});

/**
 * THE DRIFT GUARD for the prefix heuristic itself.
 *
 * Every other test in this file feeds `mapEngineFailure` a string WE wrote. That proves the mapping logic
 * but cannot prove the strings are real — and a prefix that matches nothing the engine ever emits fails
 * OPEN: the failure quietly degrades to a neutral code and no test anywhere goes red. Three of the rules
 * this file originally shipped with were exactly that.
 *
 * So this reads the installed package's own error literals and asserts each rule still matches one. On a
 * package upgrade that rewords a message, this goes red at the rule that stopped matching — which is the
 * only place the rewording is actually observable.
 */
describe('every prefix rule still matches a string the installed engine really emits', () => {
  const engineProse = (): string[] => {
    const dist = readFileSync(
      new URL('../../../node_modules/@retaxmaster/agents-realtime-server/dist/index.js', import.meta.url),
      'utf8',
    );
    const out: string[] = [];
    // `error: "..."` and `error: `...`` — for a template literal, keep only the fixed head before the
    // first interpolation, which is all a PREFIX rule can ever match against anyway.
    for (const m of dist.matchAll(/error:\s*"([^"]+)"/g)) out.push(m[1]!);
    for (const m of dist.matchAll(/error:\s*`([^`]+)`/g)) out.push(m[1]!.split('${')[0]!);
    return out.map((s) => s.toLowerCase());
  };

  it('finds the engine error literals at all (guards the guard)', () => {
    // If the extraction ever silently returns nothing, every assertion below would pass vacuously.
    expect(engineProse().length).toBeGreaterThan(10);
  });

  it.each(PREFIX_RULES.map((r) => [r.prefix, r.code] as const))(
    'prefix %j (→ %s) matches a real engine message',
    (prefix) => {
      expect(engineProse().some((p) => p.startsWith(prefix))).toBe(true);
    },
  );
});
