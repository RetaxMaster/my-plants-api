-- Which AGENT SESSION a run actually took part in.
--
-- A conversation's opening turn can fail or be cancelled BEFORE the agent ever opens a session, and that
-- turn can then be retried (possibly on another agent). The abandoned run's log therefore contains no
-- session at all — and if the host still claims it as one of the conversation's runs, the engine tries to
-- read a session out of it, fails, and the ENTIRE history read fails with it: reopening the conversation
-- 500s and renders a blank transcript, permanently.
--
-- Recording the session on the run makes membership a fact instead of a guess: a run belongs to the
-- conversation's memory iff it names the same agent session. An orphaned run keeps NULL and is simply not
-- part of it — which is the truth: the agent never saw it.
--
-- Backfill: NULL for every existing run. Runs that predate the current engine are not in its durable index
-- anyway, so the host already declines to claim them and their conversations restore from the agent's own
-- transcript. No data is lost by leaving this null.
ALTER TABLE `knowledge_chat_runs`
  ADD COLUMN `provider_session_id` VARCHAR(191) NULL;
