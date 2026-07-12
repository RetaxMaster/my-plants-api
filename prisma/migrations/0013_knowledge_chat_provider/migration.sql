-- agents-realtime 1.0.0: a knowledge-chat conversation now belongs to an AGENT (claude | codex).
--
-- `claude_session_id` becomes `provider_session_id`, because with two agents the old name is a lie for
-- half the rows (a Codex thread id is not a Claude UUID).
--
-- This is deliberately a RENAME (`CHANGE COLUMN`), NOT the DROP+ADD that `prisma migrate diff`
-- generates: a diff cannot see that a rename is intended, so its script would silently discard every
-- existing session id — and a conversation with no agent session id can never be resumed again. The
-- data is the whole point of the column, so it is carried across.
ALTER TABLE `knowledge_chat_sessions`
  CHANGE COLUMN `claude_session_id` `provider_session_id` VARCHAR(191) NULL;

-- The unique index travels with the column, but MariaDB keeps its OLD name; rename it so the schema
-- matches what Prisma expects (otherwise every later `migrate` run reports drift).
DROP INDEX `knowledge_chat_sessions_claude_session_id_key` ON `knowledge_chat_sessions`;
CREATE UNIQUE INDEX `knowledge_chat_sessions_provider_session_id_key` ON `knowledge_chat_sessions`(`provider_session_id`);

-- Every conversation that already exists was necessarily run by Claude — it is the only agent that
-- existed before this migration. The DEFAULT backfills them correctly, so no data migration is needed.
ALTER TABLE `knowledge_chat_sessions`
  ADD COLUMN `provider` VARCHAR(191) NOT NULL DEFAULT 'claude';
