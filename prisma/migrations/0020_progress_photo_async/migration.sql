-- === Per-photo processing state (spec §3.1) ==================================================
-- Widen the two image columns to NULLABLE (MODIFY preserves every existing populated value — do NOT
-- DROP+ADD). A photo row now exists before it has an R2 object.
ALTER TABLE `plant_progress_photos`
  MODIFY `image_url` VARCHAR(191) NULL,
  MODIFY `image_object_key` VARCHAR(191) NULL,
  ADD COLUMN `status` ENUM('PENDING','PROCESSING','RECOVERING','READY','FAILED') NOT NULL DEFAULT 'READY',
  ADD COLUMN `inbox_path` VARCHAR(191) NULL,
  ADD COLUMN `original_name` VARCHAR(191) NULL,
  ADD COLUMN `attempts` INT NOT NULL DEFAULT 0,
  ADD COLUMN `next_attempt_at` DATETIME(3) NULL,
  ADD COLUMN `claim_token` VARCHAR(191) NULL,
  ADD COLUMN `claimed_at` DATETIME(3) NULL,
  ADD COLUMN `failure_kind` ENUM('transient','permanent') NULL,
  ADD COLUMN `failure_code` VARCHAR(191) NULL,
  ADD COLUMN `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- Backfill: every PRE-EXISTING photo row is an already-uploaded photo (its image_url is populated), so it
-- is terminal READY and the worker must never sweep it. The READY default already covers rows inserted
-- during the deploy window; this UPDATE is stated for clarity and to normalise any legacy edge row.
UPDATE `plant_progress_photos` SET `status` = 'READY' WHERE `image_url` IS NOT NULL;

-- Replace the ordering index with the worker's sweep index (the [entry_id] index stays).
CREATE INDEX `plant_progress_photos_status_next_attempt_at_idx`
  ON `plant_progress_photos` (`status`, `next_attempt_at`);

-- === CareEvent ↔ progress-entry pairing (spec §3.3) =========================================
ALTER TABLE `care_events`
  ADD COLUMN `progress_entry_id` VARCHAR(191) NULL,
  ADD CONSTRAINT `care_events_progress_entry_id_fkey`
    FOREIGN KEY (`progress_entry_id`) REFERENCES `plant_progress_entries`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX `care_events_progress_entry_id_key` ON `care_events` (`progress_entry_id`);

-- Backfill: pair each existing PROGRESS event to the same-(plant_id, occurred_on) entry. When several
-- entries share a date, pair each duplicate event to a DISTINCT entry by createdAt order (the @unique holds
-- because each event gets a distinct entry). A ROW_NUMBER join does this deterministically.
UPDATE `care_events` ce
JOIN (
  SELECT e.id AS entry_id, e.plant_id, e.occurred_on,
         ROW_NUMBER() OVER (PARTITION BY e.plant_id, e.occurred_on ORDER BY e.created_at, e.id) AS rn
  FROM `plant_progress_entries` e
) ranked_entries
  ON ranked_entries.plant_id = ce.plant_id AND ranked_entries.occurred_on = ce.occurred_on
JOIN (
  SELECT id, plant_id, occurred_on,
         ROW_NUMBER() OVER (PARTITION BY plant_id, occurred_on ORDER BY created_at, id) AS rn
  FROM `care_events`
  WHERE task = 'PROGRESS'
) ranked_events
  ON ranked_events.id = ce.id AND ranked_events.rn = ranked_entries.rn
SET ce.progress_entry_id = ranked_entries.entry_id
WHERE ce.task = 'PROGRESS';

-- Any genuinely UNPAIRABLE PROGRESS event (no matching entry) is DELETED, not left as a null-FK straggler:
-- the care engine re-anchors Progress off the EXISTENCE of a PROGRESS event, so a stray would keep anchoring
-- a deleted entry's progress (spec §3.3 invariant).
DELETE FROM `care_events` WHERE task = 'PROGRESS' AND progress_entry_id IS NULL;
