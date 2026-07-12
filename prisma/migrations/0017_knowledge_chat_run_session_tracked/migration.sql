-- Distinguish "this run PROVABLY never reached the agent" from "we simply never tracked it".
--
-- 0016 added `provider_session_id` to a run, and NULL was read as "orphan: it never opened an agent session,
-- so excluding it from the conversation's history loses nothing". That is true for every run executed by the
-- engine that records the column — and FALSE for every run that predates it, which is also NULL but may well
-- have reached the agent. Treating those as orphans would drop their turns from a rebuilt conversation
-- silently, with no error anywhere: the exact partial-history failure the all-or-nothing rule exists to
-- prevent.
--
-- So: new runs are tracked by construction (DEFAULT TRUE), and every run that already exists is marked
-- UNTRACKED. An untracked run with no known session forces the whole conversation onto the agent's own
-- transcript, where all of its turns still live.
ALTER TABLE `knowledge_chat_runs`
  ADD COLUMN `session_tracked` BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE `knowledge_chat_runs` SET `session_tracked` = FALSE;
