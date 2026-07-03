-- Care History: add PROGRESS (seventh task, weekly journaling) to the Task enum. The enum backs four
-- tables; MariaDB stores enums per-column, so each column typed as Task is ALTERed to accept 'PROGRESS'.
ALTER TABLE `care_events` MODIFY `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES', 'MIST', 'PROGRESS') NOT NULL;
ALTER TABLE `plant_task_adjustments` MODIFY `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES', 'MIST', 'PROGRESS') NOT NULL;
ALTER TABLE `task_overrides` MODIFY `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES', 'MIST', 'PROGRESS') NOT NULL;
ALTER TABLE `due_caches` MODIFY `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES', 'MIST', 'PROGRESS') NOT NULL;

-- The owner-authored journal entry: one per recorded "progress" (health + optional observations/size/tags).
CREATE TABLE `plant_progress_entries` (
  `id`           VARCHAR(191) NOT NULL,
  `plant_id`     VARCHAR(191) NOT NULL,
  `occurred_on`  DATE         NOT NULL,
  `health`       ENUM('SICK', 'POOR', 'GOOD', 'EXCELLENT') NOT NULL,
  `observations` TEXT         NULL,
  `size_cm`      INTEGER      NULL,
  `tags`         JSON         NULL,
  `created_at`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `plant_progress_entries_plant_id_occurred_on_idx`(`plant_id`, `occurred_on`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One row per photo attached to an entry: both the render URL and the R2 object key (for later deletion).
CREATE TABLE `plant_progress_photos` (
  `id`               VARCHAR(191) NOT NULL,
  `entry_id`         VARCHAR(191) NOT NULL,
  `image_url`        VARCHAR(191) NOT NULL,
  `image_object_key` VARCHAR(191) NOT NULL,
  `sort_order`       INTEGER      NOT NULL DEFAULT 0,
  `created_at`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `plant_progress_photos_entry_id_idx`(`entry_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The frequency-override seam: a per-plant, per-task explicit interval that replaces the species base.
CREATE TABLE `plant_task_frequencies` (
  `id`            VARCHAR(191) NOT NULL,
  `plant_id`      VARCHAR(191) NOT NULL,
  `task`          ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES', 'MIST', 'PROGRESS') NOT NULL,
  `interval_days` INTEGER      NOT NULL,
  `updated_at`    DATETIME(3)  NOT NULL,
  UNIQUE INDEX `plant_task_frequencies_plant_id_task_key`(`plant_id`, `task`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign keys (match the ON DELETE RESTRICT / ON UPDATE CASCADE convention of the existing tables;
-- photos cascade-delete with their entry).
ALTER TABLE `plant_progress_entries` ADD CONSTRAINT `plant_progress_entries_plant_id_fkey` FOREIGN KEY (`plant_id`) REFERENCES `plants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `plant_progress_photos` ADD CONSTRAINT `plant_progress_photos_entry_id_fkey` FOREIGN KEY (`entry_id`) REFERENCES `plant_progress_entries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `plant_task_frequencies` ADD CONSTRAINT `plant_task_frequencies_plant_id_fkey` FOREIGN KEY (`plant_id`) REFERENCES `plants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
