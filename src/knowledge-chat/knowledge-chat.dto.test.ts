import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MAX_COMMAND_ARGS_BYTES } from '@retaxmaster/agents-realtime-protocol';
import { AgentCommandDto, CreateRunDto } from './knowledge-chat.dto.js';

// MAX_COMMAND_ARGS_BYTES is a BYTE cap (it mirrors the engine's own pre-acceptance 413 check). The old
// `@MaxLength(MAX_COMMAND_ARGS_BYTES)` counted UTF-16 CODE UNITS instead, so a multi-byte string could sit
// comfortably under the CODE-UNIT count while its real UTF-8 byte length blew past the cap — the DTO would
// accept a request the engine would then reject, turning it into a run we create and immediately fail.
describe('AgentCommandDto.args — byte cap, not character cap', () => {
  const errorsFor = (args: string) => validate(plainToInstance(AgentCommandDto, { name: 'compact', args }));

  it('rejects a multi-byte string just over the BYTE cap, even though its UTF-16 length is well under it', async () => {
    // Each 😀 is a surrogate pair: 2 UTF-16 code units, but 4 UTF-8 bytes. 2049 of them = 8196 bytes
    // (4 over the 8192 cap) yet only 4098 UTF-16 code units — half the old (wrong) limit. The OLD
    // `@MaxLength` validator would have ACCEPTED this string; the byte-aware validator must reject it.
    const emoji = '😀'.repeat(2049);
    expect(Buffer.byteLength(emoji, 'utf8')).toBe(8196);
    expect(emoji.length).toBe(4098); // UTF-16 code units — well under MAX_COMMAND_ARGS_BYTES

    const errs = await errorsFor(emoji);
    expect(errs.some((e) => e.property === 'args')).toBe(true);
  });

  it('accepts an ASCII string of the same character length (well under the byte cap)', async () => {
    const ascii = 'a'.repeat(2049); // same code-point count as the emoji string above
    expect(Buffer.byteLength(ascii, 'utf8')).toBe(2049);

    const errs = await errorsFor(ascii);
    expect(errs).toHaveLength(0);
  });

  it('accepts args exactly at the byte cap and rejects one byte over it', async () => {
    const atCap = 'a'.repeat(MAX_COMMAND_ARGS_BYTES);
    expect(await errorsFor(atCap)).toHaveLength(0);

    const overCap = 'a'.repeat(MAX_COMMAND_ARGS_BYTES + 1);
    const errs = await errorsFor(overCap);
    expect(errs.some((e) => e.property === 'args')).toBe(true);
  });
});

const validAttachment = () => ({
  id: 'a1',
  filename: 'fern.png',
  mimeType: 'image/png',
  data: Buffer.from('x'.repeat(64)).toString('base64'),
});

async function errorsFor(payload: Record<string, unknown>) {
  return validate(plainToInstance(CreateRunDto, payload), { whitelist: true });
}

describe('API-owned attachment validation (spec §4.1.1)', () => {
  it('accepts a well-formed attachment', async () => {
    expect(await errorsFor({ prompt: 'look at this', attachments: [validAttachment()] })).toEqual([]);
  });

  it('rejects more attachments than the count cap', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...validAttachment(), id: `a${i}` }));
    expect(await errorsFor({ prompt: 'x', attachments: many })).not.toEqual([]);
  });

  it('rejects a disallowed MIME type', async () => {
    expect(await errorsFor({ prompt: 'x', attachments: [{ ...validAttachment(), mimeType: 'image/svg+xml' }] })).not.toEqual([]);
  });

  it('rejects invalid base64', async () => {
    expect(await errorsFor({ prompt: 'x', attachments: [{ ...validAttachment(), data: 'not!!base64' }] })).not.toEqual([]);
  });

  it('rejects a duplicate id', async () => {
    const a = validAttachment();
    expect(await errorsFor({ prompt: 'x', attachments: [a, { ...a }] })).not.toEqual([]);
  });

  it('rejects an empty filename', async () => {
    expect(await errorsFor({ prompt: 'x', attachments: [{ ...validAttachment(), filename: '' }] })).not.toEqual([]);
  });

  it('rejects a total payload over the total cap — via the TOTAL rule, not the per-file one', async () => {
    // A single 30 MB blob would be rejected by the PER-FILE validator first, so deleting the total-cap
    // branch entirely would leave this test green. Three files that are each legal but collectively over
    // the 20 MiB total is the only shape that isolates the rule under test.
    const each = 8 * 1024 * 1024; // legal per-file (< 10 MiB); 3 x 8 = 24 MiB > 20 MiB total
    const many = Array.from({ length: 3 }, (_, i) => ({
      ...validAttachment(),
      id: `t${i}`,
      data: 'A'.repeat(Math.ceil((each * 4) / 3)),
    }));
    const errors = await errorsFor({ prompt: 'x', attachments: many });
    expect(errors).not.toEqual([]);
    // Pin WHICH constraint fired, so a per-file rejection can never masquerade as a total-cap rejection.
    expect(JSON.stringify(errors)).toContain('isValidAttachmentSet');
  });

  it('makes a command WITH attachments unrepresentable', async () => {
    // The engine answers 400 to a body carrying both, so the DTO refuses it rather than discovering it at
    // runtime — the same treatment ExecuteRequest already applies to prompt-vs-command.
    expect(await errorsFor({ command: { name: 'compact', args: '' }, attachments: [validAttachment()] })).not.toEqual([]);
  });
});
