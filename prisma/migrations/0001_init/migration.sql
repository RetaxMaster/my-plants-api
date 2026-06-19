-- CreateTable
CREATE TABLE `owners` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cities` (
    `id` VARCHAR(191) NOT NULL,
    `owner_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `timezone` VARCHAR(191) NOT NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,

    INDEX `cities_owner_id_idx`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `places` (
    `id` VARCHAR(191) NOT NULL,
    `owner_id` VARCHAR(191) NOT NULL,
    `city_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `indoor` BOOLEAN NOT NULL,
    `light_type` ENUM('DIRECT', 'BRIGHT_INDIRECT', 'MEDIUM', 'LOW') NOT NULL,
    `climate_controlled` BOOLEAN NOT NULL DEFAULT false,
    `humidity_character` ENUM('DRY', 'NORMAL', 'HUMID') NOT NULL DEFAULT 'NORMAL',
    `indoor_temp_min_c` DOUBLE NULL,
    `indoor_temp_max_c` DOUBLE NULL,

    INDEX `places_owner_id_idx`(`owner_id`),
    INDEX `places_city_id_idx`(`city_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `species` (
    `slug` VARCHAR(191) NOT NULL,
    `scientific_name` VARCHAR(191) NOT NULL,
    `record` JSON NOT NULL,

    UNIQUE INDEX `species_scientific_name_key`(`scientific_name`),
    PRIMARY KEY (`slug`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plants` (
    `id` VARCHAR(191) NOT NULL,
    `owner_id` VARCHAR(191) NOT NULL,
    `place_id` VARCHAR(191) NOT NULL,
    `species_slug` VARCHAR(191) NOT NULL,
    `nickname` VARCHAR(191) NULL,
    `acquired_on` DATE NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `plants_owner_id_idx`(`owner_id`),
    INDEX `plants_place_id_idx`(`place_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `care_events` (
    `id` VARCHAR(191) NOT NULL,
    `plant_id` VARCHAR(191) NOT NULL,
    `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES') NOT NULL,
    `type` ENUM('DONE', 'POSTPONED', 'SYMPTOM') NOT NULL,
    `occurred_on` DATE NOT NULL,
    `payload` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `care_events_plant_id_task_idx`(`plant_id`, `task`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plant_task_adjustments` (
    `id` VARCHAR(191) NOT NULL,
    `plant_id` VARCHAR(191) NOT NULL,
    `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES') NOT NULL,
    `multiplier` DOUBLE NOT NULL DEFAULT 1.0,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `plant_task_adjustments_plant_id_task_key`(`plant_id`, `task`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_overrides` (
    `id` VARCHAR(191) NOT NULL,
    `plant_id` VARCHAR(191) NOT NULL,
    `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES') NOT NULL,
    `next_due_on` DATE NOT NULL,

    UNIQUE INDEX `task_overrides_plant_id_task_key`(`plant_id`, `task`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `due_caches` (
    `id` VARCHAR(191) NOT NULL,
    `plant_id` VARCHAR(191) NOT NULL,
    `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES') NOT NULL,
    `next_due_on` DATE NOT NULL,
    `computed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `due_caches_plant_id_task_key`(`plant_id`, `task`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `scheduled_moves` (
    `id` VARCHAR(191) NOT NULL,
    `owner_id` VARCHAR(191) NOT NULL,
    `target_city_id` VARCHAR(191) NOT NULL,
    `move_on` DATE NOT NULL,
    `applied` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `scheduled_moves_owner_id_idx`(`owner_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `cities` ADD CONSTRAINT `cities_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `places` ADD CONSTRAINT `places_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `places` ADD CONSTRAINT `places_city_id_fkey` FOREIGN KEY (`city_id`) REFERENCES `cities`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plants` ADD CONSTRAINT `plants_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plants` ADD CONSTRAINT `plants_place_id_fkey` FOREIGN KEY (`place_id`) REFERENCES `places`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plants` ADD CONSTRAINT `plants_species_slug_fkey` FOREIGN KEY (`species_slug`) REFERENCES `species`(`slug`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `care_events` ADD CONSTRAINT `care_events_plant_id_fkey` FOREIGN KEY (`plant_id`) REFERENCES `plants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plant_task_adjustments` ADD CONSTRAINT `plant_task_adjustments_plant_id_fkey` FOREIGN KEY (`plant_id`) REFERENCES `plants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_overrides` ADD CONSTRAINT `task_overrides_plant_id_fkey` FOREIGN KEY (`plant_id`) REFERENCES `plants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `due_caches` ADD CONSTRAINT `due_caches_plant_id_fkey` FOREIGN KEY (`plant_id`) REFERENCES `plants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
