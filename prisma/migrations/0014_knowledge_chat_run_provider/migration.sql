-- The agent a run was launched with, recorded ON the run.
--
-- Why the session's `provider` column is not enough: a conversation whose opening turn never reached an
-- agent may be RETRIED on a different agent. If a late callback from the old run then reports its session
-- id, the session row could end up with `provider` naming one agent and `provider_session_id` belonging to
-- the other — a conversation that claims to be Codex while holding a Claude memory. Recording the agent on
-- the run lets the session be sealed with BOTH values taken from the SAME run, atomically, so the pair can
-- never cross.
--
-- Backfill: every existing run was launched with the agent its session names, and before this migration the
-- only agent that existed was Claude — so the default is correct for all of them.
ALTER TABLE `knowledge_chat_runs`
  ADD COLUMN `provider` VARCHAR(191) NOT NULL DEFAULT 'claude';
