-- AlterTable
ALTER TABLE `knowledge_chat_runs` ADD COLUMN `system_message_proposal_id` VARCHAR(191) NULL,
    ADD COLUMN `system_message_state` ENUM('CONSUMED', 'DELIVERED', 'RESTORED', 'DROPPED') NULL,
    ADD COLUMN `system_message_text` TEXT NULL,
    MODIFY `status` ENUM('QUEUED', 'LAUNCHING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED';

-- AlterTable
ALTER TABLE `knowledge_chat_sessions` ADD COLUMN `pending_system_message` TEXT NULL,
    ADD COLUMN `pending_system_message_proposal_id` VARCHAR(191) NULL,
    ADD COLUMN `skip_permissions` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `skip_permissions_set_at` DATETIME(3) NULL,
    ADD COLUMN `skip_permissions_set_by_user_id` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `doctor_write_proposals` (
    `id` VARCHAR(191) NOT NULL,
    `session_id` VARCHAR(191) NOT NULL,
    `run_id` VARCHAR(191) NOT NULL,
    `plant_id` VARCHAR(191) NOT NULL,
    `owner_id` VARCHAR(191) NOT NULL,
    `operations` TEXT NOT NULL,
    `snapshot` TEXT NOT NULL,
    `summary` TEXT NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'DECLINED', 'EXPIRED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `pending_key` VARCHAR(191) NULL,
    `auto_approved` BOOLEAN NOT NULL DEFAULT false,
    `failure_code` ENUM('VALIDATION', 'NOT_FOUND', 'OWNERSHIP', 'CONFLICT', 'INTERNAL') NULL,
    `failure_reason` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolved_at` DATETIME(3) NULL,
    `resolved_by_user_id` VARCHAR(191) NULL,

    INDEX `doctor_write_proposals_plant_id_idx`(`plant_id`),
    INDEX `doctor_write_proposals_run_id_idx`(`run_id`),
    UNIQUE INDEX `doctor_write_proposals_session_id_pending_key_key`(`session_id`, `pending_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plant_write_audit` (
    `id` VARCHAR(191) NOT NULL,
    `plant_id` VARCHAR(191) NOT NULL,
    `owner_id` VARCHAR(191) NOT NULL,
    `origin` ENUM('OWNER', 'DOCTOR') NOT NULL,
    `proposal_id` VARCHAR(191) NULL,
    `actor_user_id` VARCHAR(191) NULL,
    `operation_type` VARCHAR(191) NOT NULL,
    `target_table` VARCHAR(191) NOT NULL,
    `target_id` VARCHAR(191) NULL,
    `payload_json` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `plant_write_audit_plant_id_created_at_idx`(`plant_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `doctor_write_proposals` ADD CONSTRAINT `doctor_write_proposals_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `knowledge_chat_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

