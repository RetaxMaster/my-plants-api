import { describe, it, expect } from 'vitest';
import { splitStoredPrompt } from './legacy-prompt-split.js';

// =====================================================================================================
// FIXTURE PROVENANCE — these strings were OBSERVED, not authored.
//
// The local database held ZERO rows with a system message, so (per the plan's mandatory provenance step)
// a real one was produced by running the CURRENT, UNMODIFIED `admitRun` against the real database with
// `pendingSystemMessage` seeded. What it wrote, verbatim:
//
//   -- message + user text ------------------------------------------------------------------
//   prompt             = "[system] The user declined your request.\n\nHow is my fern?"
//   systemMessageText  = "[system] The user declined your request."
//   systemMessageState = "CONSUMED"
//
//   -- message alone (the decline-triggered turn, caller passes prompt: '') -------------------
//   prompt             = "[system] The user declined your request."
//   systemMessageText  = "[system] The user declined your request."
//
// THE PLAN ASSUMED ONE PRE-CHANGE SHAPE; THERE ARE TWO. The old code stored the marker on BOTH columns,
// because it composed both of them from the same already-marked `SYSTEM_MESSAGE.declined` constant. The
// asymmetry the plan describes (prefixed `prompt`, stripped `systemMessageText`) does not exist yet — it
// comes into being only AFTER Task 26 normalises `systemMessageText` and deliberately leaves `prompt`
// alone. So a live database contains:
//
//   SHAPE 1 "symmetric, marked"  — every pre-change row TODAY, and every pre-change row in production
//                                  until the Task 26 script runs.
//   SHAPE 2 "asymmetric"         — those same rows AFTER Task 26 runs.
//   SHAPE 3 "symmetric, bare"    — post-change rows, where `prompt` is the user's text alone.
//
// Both 1 and 2 must be handled, or the rule is a no-op for one half of the migration window. Fixtures
// covering only shape 2 would have gone green while every row that exists right now fell through to the
// non-match branch.
// =====================================================================================================

const OBSERVED_MARKED_SYSTEM_TEXT = '[system] The user declined your request.';
const OBSERVED_BARE_SYSTEM_TEXT = 'The user declined your request.';
const OBSERVED_CONCATENATED_PROMPT = '[system] The user declined your request.\n\nHow is my fern?';
const OBSERVED_ALONE_PROMPT = '[system] The user declined your request.';

describe('splitStoredPrompt', () => {
  describe('SHAPE 1 — the row as it exists in the database TODAY (marker on both columns)', () => {
    it('splits the observed concatenated row', () => {
      expect(splitStoredPrompt(OBSERVED_CONCATENATED_PROMPT, OBSERVED_MARKED_SYSTEM_TEXT)).toEqual({
        userMessage: 'How is my fern?',
      });
    });

    it('splits the observed message-alone row', () => {
      expect(splitStoredPrompt(OBSERVED_ALONE_PROMPT, OBSERVED_MARKED_SYSTEM_TEXT)).toEqual({
        userMessage: '',
      });
    });
  });

  describe('SHAPE 2 — the same rows AFTER Task 26 strips systemMessageText (asymmetric)', () => {
    it('splits a marker-prefixed prompt against a stripped systemMessageText', () => {
      expect(splitStoredPrompt(OBSERVED_CONCATENATED_PROMPT, OBSERVED_BARE_SYSTEM_TEXT)).toEqual({
        userMessage: 'How is my fern?',
      });
    });

    it('splits the message-alone row against a stripped systemMessageText', () => {
      expect(splitStoredPrompt(OBSERVED_ALONE_PROMPT, OBSERVED_BARE_SYSTEM_TEXT)).toEqual({
        userMessage: '',
      });
    });
  });

  describe('SHAPE 3 — fully normalised / post-change rows', () => {
    it('splits an unprefixed row normalised on both sides', () => {
      expect(
        splitStoredPrompt(`${OBSERVED_BARE_SYSTEM_TEXT}\n\nHow is my fern?`, OBSERVED_BARE_SYSTEM_TEXT),
      ).toEqual({ userMessage: 'How is my fern?' });
    });

    it('returns an empty user message when the prompt IS the system message', () => {
      expect(splitStoredPrompt(OBSERVED_BARE_SYSTEM_TEXT, OBSERVED_BARE_SYSTEM_TEXT)).toEqual({
        userMessage: '',
      });
    });

    it('is idempotent on an already-split post-change row', () => {
      // A post-change row's prompt is the user half only, so it does not match — the caller uses it as-is.
      expect(splitStoredPrompt('How is my fern?', OBSERVED_BARE_SYSTEM_TEXT)).toBeNull();
    });
  });

  describe('multi-line system text from failed(reason)', () => {
    // `SYSTEM_MESSAGE.failed(reason)` interpolates a reason we do not constrain, so the system half can be
    // multi-line — which is precisely why splitting on the first `\n\n` is not implementable safely.
    const sys = 'Your request could not be applied: line one\nline two';

    it('handles it in all three shapes', () => {
      expect(splitStoredPrompt(`[system] ${sys}\n\nand my question`, `[system] ${sys}`)).toEqual({
        userMessage: 'and my question',
      });
      expect(splitStoredPrompt(`[system] ${sys}\n\nand my question`, sys)).toEqual({
        userMessage: 'and my question',
      });
      expect(splitStoredPrompt(`${sys}\n\nand my question`, sys)).toEqual({
        userMessage: 'and my question',
      });
    });
  });

  describe('non-matches — the rule is exact-match, never a heuristic', () => {
    it('returns null when the prompt does not carry the system message (a user who typed it themselves)', () => {
      expect(
        splitStoredPrompt('The user declined your request. (I typed this)', OBSERVED_BARE_SYSTEM_TEXT),
      ).toBeNull();
    });

    it('returns null for a user prompt that merely BEGINS with the marker', () => {
      expect(splitStoredPrompt('[system] I am quoting this on purpose', OBSERVED_BARE_SYSTEM_TEXT)).toBeNull();
    });

    it('returns null when there is no system message to match against', () => {
      expect(splitStoredPrompt('How is my fern?', null)).toBeNull();
    });

    it('returns null for an empty system message rather than matching every prompt', () => {
      expect(splitStoredPrompt('How is my fern?', '')).toBeNull();
    });

    it('returns null for a null prompt', () => {
      expect(splitStoredPrompt(null, 'anything')).toBeNull();
    });
  });
});
