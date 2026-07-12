-- Migration 0018 made `prompt` nullable and added `command_name`/`command_args`, but nothing in the DB
-- actually enforced "exactly one of (prompt) / (command_name, command_args)" — the table happily accepted
-- both sides set, neither set, or `command_name` without `command_args`. This migration turns the claimed
-- invariant into a real CHECK constraint. MariaDB enforces CHECK constraints (unlike MySQL < 8.0.16).
--
-- Every existing row (prompt set, command columns null) satisfies this immediately — no backfill needed.
--
-- NOTE: Prisma's schema.prisma / `prisma migrate diff` do NOT model CHECK constraints (Prisma has no
-- first-class representation for them), so a diff against schema.prisma will NOT show this constraint and
-- may report the DB as "in sync" without it. That is expected and not a drift bug — this constraint is
-- intentionally DB-only, hand-authored, and invisible to Prisma's own drift detection.
ALTER TABLE `knowledge_chat_runs`
  ADD CONSTRAINT `knowledge_chat_runs_prompt_xor_command` CHECK (
    (`prompt` IS NOT NULL AND `command_name` IS NULL AND `command_args` IS NULL)
    OR (`prompt` IS NULL AND `command_name` IS NOT NULL AND `command_args` IS NOT NULL)
  );
