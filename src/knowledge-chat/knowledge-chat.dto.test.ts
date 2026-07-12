import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MAX_COMMAND_ARGS_BYTES } from '@retaxmaster/agents-realtime-protocol';
import { AgentCommandDto } from './knowledge-chat.dto.js';

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
