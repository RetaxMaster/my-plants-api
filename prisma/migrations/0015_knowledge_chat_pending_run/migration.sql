-- Which run currently has the right to SEAL a conversation to an agent.
--
-- A conversation whose opening turn never reached an agent can be retried, possibly on a DIFFERENT agent.
-- The abandoned run may still report its `session.started` afterwards. Deciding "may this run seal?" by
-- reading the newest run and then writing is a TOCTOU race: the old run can pass that check and seal the
-- conversation the retry already owns — pinning it to the agent the user just walked away from.
--
-- With this column the seal becomes ONE conditional statement that can only affect the run that still
-- holds the claim:  UPDATE ... SET provider_session_id = ?, provider = ?
--                   WHERE id = ? AND provider_session_id IS NULL AND pending_run_id = ?
ALTER TABLE `knowledge_chat_sessions`
  ADD COLUMN `pending_run_id` VARCHAR(191) NULL;

-- Backfill any conversation with a run in flight RIGHT NOW, so a run that spans this deploy can still seal
-- itself when its session id arrives. The @@unique([session_id, active_key]) constraint guarantees at most
-- one such run per conversation, so this join cannot produce an ambiguous winner. Every other conversation
-- correctly gets NULL: it has no run in flight, so no run may seal it.
UPDATE `knowledge_chat_sessions` s
  JOIN `knowledge_chat_runs` r ON r.`session_id` = s.`id` AND r.`active_key` = 'ACTIVE'
  SET s.`pending_run_id` = r.`id`;
