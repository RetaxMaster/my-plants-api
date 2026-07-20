import { describe, it, expect } from 'vitest';
import { makeRecognizer } from './legacy-system-recognizer.js';

// Fixture provenance: the same OBSERVED pre-change row that `legacy-prompt-split.test.ts` documents — the
// marker sits on BOTH the prompt and `systemMessageText` as the old code wrote them, and only on the prompt
// once §3.5 has normalised the column. Both are exercised; see that file's header for how they were read.
const MARKED = '[system] The user declined your request.';
const BARE = 'The user declined your request.';

describe('the legacy system-message recognizer', () => {
  it('splits the concatenated shape as it really appears in a legacy log (marked on both sides)', () => {
    const recognize = makeRecognizer({ systemMessageText: MARKED, systemMessageState: 'CONSUMED' });
    expect(recognize(`${MARKED}\n\nHow is my fern?`)).toEqual({
      systemMessage: MARKED,
      userMessage: 'How is my fern?',
    });
  });

  it('splits the same log line once the run row has been normalised (asymmetric)', () => {
    const recognize = makeRecognizer({ systemMessageText: BARE, systemMessageState: 'CONSUMED' });
    expect(recognize(`${MARKED}\n\nHow is my fern?`)).toEqual({
      systemMessage: BARE,
      userMessage: 'How is my fern?',
    });
  });

  it('handles the ALONE shape — the decline-triggered turn the migration guide example would skip', () => {
    // The guide's example recognizer requires a \n\n and would silently skip this.
    const recognize = makeRecognizer({ systemMessageText: BARE, systemMessageState: 'CONSUMED' });
    expect(recognize(MARKED)).toEqual({ systemMessage: BARE, userMessage: '' });
  });

  it('handles a MULTI-LINE system message from failed(reason)', () => {
    const sys = 'Your request could not be applied: the value\nspanned two lines';
    const recognize = makeRecognizer({ systemMessageText: sys, systemMessageState: 'CONSUMED' });
    expect(recognize(`[system] ${sys}\n\nand then my question`)).toEqual({
      systemMessage: sys,
      userMessage: 'and then my question',
    });
  });

  it('leaves untouched a user prompt that BEGINS with [system] but does not match the run row', () => {
    // Any rule that accepts "starts with [system]" also claims a user who legitimately typed the prefix —
    // the exact mutilation the package refused to risk on our behalf.
    const recognize = makeRecognizer({ systemMessageText: BARE, systemMessageState: 'CONSUMED' });
    expect(recognize('[system] I am quoting this on purpose')).toBeNull();
  });

  it('returns null for EVERY turn when the run consumed no message', () => {
    // A run row whose systemMessageText is absent can never produce a false positive, because there is
    // nothing to match against.
    const recognize = makeRecognizer({ systemMessageText: null, systemMessageState: null });
    expect(recognize('anything at all')).toBeNull();
    expect(recognize('')).toBeNull();
  });
});
