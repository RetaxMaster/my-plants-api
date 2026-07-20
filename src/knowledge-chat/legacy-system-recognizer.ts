import { splitStoredPrompt } from './legacy-prompt-split.js';

/**
 * The recognizer `promoteLegacySystemMessages` needs (spec §3.4). The package ships none DELIBERATELY: a
 * built-in one would mutilate a user who legitimately typed the prefix.
 *
 * Ours is EXACT MATCH AGAINST OUR OWN DATABASE, not a text heuristic. We do not have to guess, because we
 * hold the ground truth: a log file belongs to exactly one run (its logPath is derived from the run id),
 * and that run's row carries the consumed message verbatim in `KnowledgeChatRun.systemMessageText`. That
 * makes multi-line system text, an interpolated `failed()` reason, and a user who typed the prefix all
 * correct BY CONSTRUCTION rather than by heuristic.
 *
 * It shares `splitStoredPrompt` with the turn mapping and the rescue — the match-and-split is ONE
 * implementation with three call sites, and each call site maps the non-match itself. The LOG side returns
 * null so the recognizer leaves the turn untouched.
 */
export function makeRecognizer(run: {
  systemMessageText: string | null;
  systemMessageState: string | null;
}): (userPromptText: string) => { systemMessage: string; userMessage: string } | null {
  // No message was consumed by this run: nothing in this file can be promoted, so refuse every turn.
  if (run.systemMessageState === null || run.systemMessageText === null) return () => null;

  const systemMessage = run.systemMessageText;
  return (userPromptText: string) => {
    const split = splitStoredPrompt(userPromptText, systemMessage);
    // `LegacySystemSplit.userMessage` is a REQUIRED string, so the alone shape is `userMessage: ''`. That
    // is NOT what a native 3.0.0 turn looks like — `buildTurnInputEvent` OMITS blank fields by contract, so
    // a native system-message-only turn emits `turn.input` with no `userMessage` key at all. Task 25
    // asserts the client renders both shapes identically, so the divergence stays invisible to users.
    return split ? { systemMessage, userMessage: split.userMessage } : null;
  };
}
