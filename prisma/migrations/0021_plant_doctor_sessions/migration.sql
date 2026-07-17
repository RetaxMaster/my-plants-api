-- Session ↔ plant scoping (Plant Doctor Spec 3 §3.1). Deploy-window-safe: `kind` defaults to KNOWLEDGE and
-- the plant/owner columns are nullable, so pre-migration code that inserts KE sessions with none of these
-- keeps working during `prisma migrate deploy`, and existing rows read back as KNOWLEDGE/null with no
-- backfill. No date/time columns → no MariaDB-date concern.

-- AlterTable
ALTER TABLE `knowledge_chat_sessions` ADD COLUMN `kind` ENUM('KNOWLEDGE', 'DOCTOR') NOT NULL DEFAULT 'KNOWLEDGE',
    ADD COLUMN `owner_id` VARCHAR(191) NULL,
    ADD COLUMN `plant_id` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `knowledge_chat_sessions_kind_plant_id_idx` ON `knowledge_chat_sessions`(`kind`, `plant_id`);

-- CreateIndex
CREATE INDEX `knowledge_chat_sessions_owner_id_idx` ON `knowledge_chat_sessions`(`owner_id`);

-- AddForeignKey
ALTER TABLE `knowledge_chat_sessions` ADD CONSTRAINT `knowledge_chat_sessions_plant_id_fkey` FOREIGN KEY (`plant_id`) REFERENCES `plants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
