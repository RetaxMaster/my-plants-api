/**
 * The retired marker. Task 2 removes it from every message we WRITE; it lives on here because rows written
 * before that change still carry it — forever, in `prompt`, which is deliberately never rewritten. Do not
 * use it anywhere else.
 */
const LEGACY_SYSTEM_MARKER = '[system]';

/**
 * THE de-concatenation rule for the MIXED `KnowledgeChatRun.prompt` column (spec §3.1.1).
 *
 * Before the 3.0.x adoption, `admitRun` persisted `${systemMessage}\n\n${userText}` (or the system message
 * alone) into `prompt`. After it, `prompt` holds the user's text only and the system message lives in
 * `systemMessageText`. Rows of BOTH shapes coexist forever, because §3.5 deliberately normalises
 * `systemMessageText` and `pendingSystemMessage` but never rewrites `prompt`.
 *
 * This is EXACT MATCH against our own database, never a text heuristic. `SYSTEM_MESSAGE.failed(reason)`
 * interpolates a reason we do not constrain, so the system half can be multi-line; and any rule that
 * accepts "looks like a system message" also mutilates a user who legitimately typed one.
 *
 * ONE implementation, THREE call sites: the log recognizer, the turn mapping (reader 1), and the
 * legacy-log rescue (reader 3). Each call site maps the NON-match itself — the log side returns null so the
 * recognizer leaves the turn untouched, the row side falls through to "use `prompt` as-is". A single
 * function returning null for both would make the rescue drop the prompt entirely.
 *
 * @returns the user's half when the prompt provably carries the system message, otherwise `null`.
 */
export function splitStoredPrompt(
  prompt: string | null | undefined,
  systemMessageText: string | null | undefined,
): { userMessage: string } | null {
  if (prompt == null || systemMessageText == null || systemMessageText === '') return null;

  // THE TWO OPERANDS MAY OR MAY NOT BE MARKED THE SAME WAY, and missing either case makes the rule a no-op
  // across half the migration window. Observed by running the pre-change `admitRun` against the real
  // database, a genuine legacy row passes through THREE shapes over its life:
  //
  //   1. AS WRITTEN (every such row today, and in production until §3.5 runs) — marked on BOTH columns,
  //      because the old code composed both from the same already-marked SYSTEM_MESSAGE constant:
  //          prompt            = '[system] X\n\nUser text'
  //          systemMessageText = '[system] X'
  //
  //   2. AFTER §3.5 NORMALISATION — asymmetric, because the script strips the marker from
  //      `systemMessageText` and deliberately never rewrites `prompt`:
  //          prompt            = '[system] X\n\nUser text'
  //          systemMessageText = 'X'
  //
  //   3. POST-CHANGE rows — `prompt` is the user's text alone and never matches at all.
  //
  // A naive `prompt.startsWith(`${systemMessageText}\n\n`)` handles shape 1 but is FALSE for every row in
  // shape 2; a rule that only prepends the marker handles shape 2 but is false for shape 1. Either way the
  // three call sites silently take their non-match branch: reader 1 ships the raw `[system] …` string to
  // the browser labelled `you` (the exact symptom spec §3.1.1 exists to end), reader 3 emits the
  // instruction TWICE, and the recognizer turns the promotion into a silent no-op indistinguishable from
  // "nothing to promote" — the ambiguity the survey exists to eliminate.
  //
  // So we try BOTH spellings of the system half: as stored, and marker-prefixed.
  const candidates = [systemMessageText, `${LEGACY_SYSTEM_MARKER} ${systemMessageText}`];

  for (const candidate of candidates) {
    if (prompt === candidate) return { userMessage: '' };
    const withSeparator = `${candidate}\n\n`;
    if (prompt.startsWith(withSeparator)) return { userMessage: prompt.slice(withSeparator.length) };
  }
  return null;
}
