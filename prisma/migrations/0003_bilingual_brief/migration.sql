-- The brief is now stored in two languages. Rename the existing English brief column (lossless,
-- preserves data) and add the Spanish one. Both nullable; the deterministic db:insert always
-- writes both going forward.
ALTER TABLE `species` RENAME COLUMN `brief` TO `brief_en`;
ALTER TABLE `species` ADD COLUMN `brief_es` TEXT NULL;
