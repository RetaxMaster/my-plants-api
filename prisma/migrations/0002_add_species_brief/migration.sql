-- Add the Markdown brief to the species table so curated knowledge lives entirely in the DB
-- (the knowledge-engine no longer keeps `brief.md` files on disk). Nullable so the column can be
-- added to existing rows; the deterministic db:insert always writes a non-empty brief going forward.
ALTER TABLE `species` ADD COLUMN `brief` TEXT NULL;
