import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_ATTACHMENT_MAX_COUNT,
  DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
  DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES,
  DEFAULT_UPLOAD_TTL_MS,
} from '@retaxmaster/agents-realtime-protocol';
import { ATTACHMENT_CAPS, UPLOAD_TTL_MS, ALLOWED_ATTACHMENT_MIMES, requiredBodyBytes } from './body-limit.js';

describe('the caps track the protocol package (an UPGRADE tripwire, not a no-fork proof)', () => {
  // BE HONEST ABOUT WHAT THIS CATCHES. Comparing our value to the package's cannot detect a literal copy
  // today — `maxCount: 6` and DEFAULT_ATTACHMENT_MAX_COUNT are both 6, so a fork stays green until the
  // package moves. What it DOES catch is the moment of drift: the first upgrade that changes a default
  // turns a copied literal red. That is worth having, but it is not the no-fork guard; the source-level
  // check below is.
  it('tracks the package defaults exactly', () => {
    expect(ATTACHMENT_CAPS.maxCount).toBe(DEFAULT_ATTACHMENT_MAX_COUNT);
    expect(ATTACHMENT_CAPS.maxFileBytes).toBe(DEFAULT_ATTACHMENT_MAX_FILE_BYTES);
    expect(ATTACHMENT_CAPS.maxTotalBytes).toBe(DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES);
    expect(UPLOAD_TTL_MS).toBe(DEFAULT_UPLOAD_TTL_MS);
  });

  it('exposes the MIME allowlist as an ARRAY — the package exports a ReadonlySet', () => {
    expect(Array.isArray(ALLOWED_ATTACHMENT_MIMES)).toBe(true);
    expect(ALLOWED_ATTACHMENT_MIMES).toContain('image/png');
    expect(ALLOWED_ATTACHMENT_MIMES).toContain('image/webp');
    expect(ALLOWED_ATTACHMENT_MIMES).not.toContain('image/svg+xml');
  });

  it('THE ACTUAL NO-FORK GUARD: the source declares no cap literal', () => {
    // The value comparison above cannot see a fork while the numbers coincide, so check the SOURCE. This
    // is the assertion that fires the moment someone types the number instead of importing it.
    const source = readFileSync(new URL('./body-limit.ts', import.meta.url), 'utf8');
    const capsBlock = source.slice(
      source.indexOf('export const ATTACHMENT_CAPS'),
      source.indexOf('ALLOWED_ATTACHMENT_MIMES'),
    );
    expect(capsBlock).toContain('DEFAULT_ATTACHMENT_MAX_COUNT');
    expect(capsBlock).toContain('DEFAULT_ATTACHMENT_MAX_FILE_BYTES');
    expect(capsBlock).toContain('DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES');
    expect(capsBlock).not.toMatch(/\b\d{4,}\b|\b6\b\s*,/); // no raw byte counts, no bare `6,`
  });
});

describe('requiredBodyBytes', () => {
  it('is DERIVED from the caps — raising the total cap raises the limit', () => {
    const base = requiredBodyBytes(ATTACHMENT_CAPS);
    const raised = requiredBodyBytes({ ...ATTACHMENT_CAPS, maxTotalBytes: ATTACHMENT_CAPS.maxTotalBytes * 2 });
    expect(raised).toBeGreaterThan(base);
  });

  it('is DERIVED from the count cap too', () => {
    const base = requiredBodyBytes(ATTACHMENT_CAPS);
    const raised = requiredBodyBytes({ ...ATTACHMENT_CAPS, maxCount: ATTACHMENT_CAPS.maxCount + 1 });
    expect(raised).toBeGreaterThan(base);
  });

  it('does NOT consume the per-file cap — the total already bounds the payload', () => {
    const base = requiredBodyBytes(ATTACHMENT_CAPS);
    const raised = requiredBodyBytes({ ...ATTACHMENT_CAPS, maxFileBytes: ATTACHMENT_CAPS.maxFileBytes * 4 });
    expect(raised).toBe(base);
  });

  it('THE DRIFT ALARM: our computed limit never exceeds the engine own body limit', () => {
    // Four terms below are LOCAL MIRRORS of unexported package internals. If a mirror drifts HIGH, our API
    // admits a body the engine's body parser refuses BEFORE any attachment validation runs — surfacing in
    // production as a mystery 413. This assertion makes that drift fail the build instead.
    expect(requiredBodyBytes(ATTACHMENT_CAPS)).toBeLessThanOrEqual(DEFAULT_BODY_LIMIT_BYTES);
  });

  it('counts the composed prompt cap ONCE — a full prompt PLUS a full system message is not legal', () => {
    // MAX_PROMPT_BYTES caps the COMPOSED string, so budgeting it twice would silently double the headroom.
    const withoutAttachments = requiredBodyBytes({ maxCount: 0, maxFileBytes: 0, maxTotalBytes: 0 });
    expect(withoutAttachments).toBe(131072 + 1024 + 65536);
  });
});
