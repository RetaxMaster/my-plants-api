-- Add MIST (sixth care cycle) to the Task enum. The enum backs four tables; MariaDB stores enums
-- per-column, so each column typed as Task must be ALTERed to accept the new value.
ALTER TABLE `care_events` MODIFY `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES', 'MIST') NOT NULL;
ALTER TABLE `plant_task_adjustments` MODIFY `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES', 'MIST') NOT NULL;
ALTER TABLE `task_overrides` MODIFY `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES', 'MIST') NOT NULL;
ALTER TABLE `due_caches` MODIFY `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES', 'MIST') NOT NULL;
