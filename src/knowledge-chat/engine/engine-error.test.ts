import { describe, it, expect } from 'vitest';
import { mapEngineFailure } from './engine-error.js';

describe('mapEngineFailure (spec §7)', () => {
  // The prefix match must be exercised WITHIN a status, not only across statuses — one case per status
  // would verify only the status half and never the discrimination this mapping exists for.
  it('discriminates two DIFFERENT 422 failures into two DIFFERENT codes', () => {
    expect(mapEngineFailure(422, { error: 'attachments are not configured on this server' }).code)
      .toBe('attachments_unavailable');
    expect(mapEngineFailure(422, { error: 'attachment write failed', detail: '/srv/x' }).code)
      .toBe('attachment_write_failed');
  });

  it('discriminates BOTH 413 codes', () => {
    expect(mapEngineFailure(413, { error: 'attachment exceeds the per-file limit' }).code)
      .toBe('attachment_too_large');
    expect(mapEngineFailure(413, { error: 'composed prompt too large', maxBytes: 1, actualBytes: 2 }).code)
      .toBe('message_too_long');
  });

  it('maps a magic-byte / MIME mismatch to attachment_corrupt', () => {
    expect(mapEngineFailure(422, { error: 'attachment mimeType is not an allowed image type: image/png' }).code)
      .toBe('attachment_corrupt');
  });

  it('maps an oversized turn.input event to message_too_long', () => {
    expect(mapEngineFailure(413, { error: 'turn.input event too large', maxBytes: 1, actualBytes: 2 }).code)
      .toBe('message_too_long');
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
