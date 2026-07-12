-- A command turn has NO prompt (agents-realtime 2.0.0: a command travels in its own field, never inside
-- the prompt). `MODIFY` preserves every existing row's prompt — do NOT rewrite this as DROP + ADD.
ALTER TABLE `knowledge_chat_runs`
  MODIFY `prompt` TEXT NULL,
  ADD COLUMN `command_name` VARCHAR(191) NULL,
  ADD COLUMN `command_args` TEXT NULL;
