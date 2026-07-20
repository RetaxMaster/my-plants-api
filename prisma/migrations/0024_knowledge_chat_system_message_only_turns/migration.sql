-- Migration 0019 encoded the turn-input invariant as a strict XOR: a run carries EITHER a prompt OR a
-- command, and a row with neither was illegal. That was correct for every turn shape that existed then.
--
-- The agents-realtime 3.0.x adoption introduces a THIRD legal shape. A system message used to be
-- concatenated into the prompt, so a decline-triggered turn wrote `prompt = '[system] ...'` and satisfied
-- the XOR by accident. It is now delivered out of band in its own `systemMessage` field, and the spec
-- makes a system-message-only run explicit: `prompt` NULL with the message in `system_message_text`. That
-- row has neither a prompt nor a command, so the 0019 constraint REJECTS IT.
--
-- The consequence was not theoretical and not loud. `ProposalsService.decline` starts the queued turn
-- best-effort (the decline is already durably recorded, so a launch failure must never fail the owner's
-- click), so the insert failed inside a swallowed catch: the proposal was declined, the message stayed
-- queued, and no run ever started. The agent was never told it had been declined — the exact defect this
-- feature exists to fix, reproduced in a new form one layer down. The consent gate was never weakened:
-- nothing is auto-approved, and the decline itself was always recorded correctly.
--
-- The invariant this restores is the REAL one — a turn must carry at least one input, and prompt and
-- command remain mutually exclusive:
--   1. a prompt turn      — prompt set, no command (may ALSO carry a system message; that is the ordinary
--                           owner turn that consumed a queued notice, and branch 1 does not constrain it);
--   2. a command turn     — both command columns set together, no prompt;
--   3. a system-message-only turn — neither, but `system_message_text` present. NEW.
--
-- A row with none of the three stays illegal, which is the case the XOR was really protecting against.
--
-- The constraint is RENAMED, because `prompt_xor_command` no longer describes what it enforces and a stale
-- name on a constraint is how the next reader derives the wrong invariant.
--
-- Every existing row satisfies this immediately — the new branch only WIDENS what is accepted, so no
-- backfill is needed and no row can be invalidated by applying it.
--
-- NOTE (carried from 0019): Prisma's schema.prisma / `prisma migrate diff` do NOT model CHECK constraints,
-- so a diff against schema.prisma will NOT show this and may report the DB as "in sync" without it. That
-- is expected and not a drift bug — this constraint is intentionally DB-only and hand-authored.
ALTER TABLE `knowledge_chat_runs`
  DROP CONSTRAINT `knowledge_chat_runs_prompt_xor_command`;

ALTER TABLE `knowledge_chat_runs`
  ADD CONSTRAINT `knowledge_chat_runs_turn_input_shape` CHECK (
    (`prompt` IS NOT NULL AND `command_name` IS NULL AND `command_args` IS NULL)
    OR (`prompt` IS NULL AND `command_name` IS NOT NULL AND `command_args` IS NOT NULL)
    OR (
      `prompt` IS NULL
      AND `command_name` IS NULL
      AND `command_args` IS NULL
      AND `system_message_text` IS NOT NULL
    )
  );
