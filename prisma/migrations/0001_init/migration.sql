-- CreateTable
CREATE TABLE `owners` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cities` (
    `id` VARCHAR(191) NOT NULL,
    `ownerId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `latitude` DOUBLE NOT NULL,
    `longitude` DOUBLE NOT NULL,
    `timezone` VARCHAR(191) NOT NULL,
    `isPrimary` BOOLEAN NOT NULL DEFAULT false,

    INDEX `cities_ownerId_idx`(`ownerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `places` (
    `id` VARCHAR(191) NOT NULL,
    `ownerId` VARCHAR(191) NOT NULL,
    `cityId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `indoor` BOOLEAN NOT NULL,
    `lightType` ENUM('DIRECT', 'BRIGHT_INDIRECT', 'MEDIUM', 'LOW') NOT NULL,
    `climateControlled` BOOLEAN NOT NULL DEFAULT false,
    `humidityCharacter` ENUM('DRY', 'NORMAL', 'HUMID') NOT NULL DEFAULT 'NORMAL',
    `indoorTempMinC` DOUBLE NULL,
    `indoorTempMaxC` DOUBLE NULL,

    INDEX `places_ownerId_idx`(`ownerId`),
    INDEX `places_cityId_idx`(`cityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `species` (
    `slug` VARCHAR(191) NOT NULL,
    `scientificName` VARCHAR(191) NOT NULL,
    `record` JSON NOT NULL,

    UNIQUE INDEX `species_scientificName_key`(`scientificName`),
    PRIMARY KEY (`slug`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plants` (
    `id` VARCHAR(191) NOT NULL,
    `ownerId` VARCHAR(191) NOT NULL,
    `placeId` VARCHAR(191) NOT NULL,
    `speciesSlug` VARCHAR(191) NOT NULL,
    `nickname` VARCHAR(191) NULL,
    `acquiredOn` DATE NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `plants_ownerId_idx`(`ownerId`),
    INDEX `plants_placeId_idx`(`placeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `care_events` (
    `id` VARCHAR(191) NOT NULL,
    `plantId` VARCHAR(191) NOT NULL,
    `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES') NOT NULL,
    `type` ENUM('DONE', 'POSTPONED', 'SYMPTOM') NOT NULL,
    `occurredOn` DATE NOT NULL,
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `care_events_plantId_task_idx`(`plantId`, `task`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plant_task_adjustments` (
    `id` VARCHAR(191) NOT NULL,
    `plantId` VARCHAR(191) NOT NULL,
    `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES') NOT NULL,
    `multiplier` DOUBLE NOT NULL DEFAULT 1.0,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `plant_task_adjustments_plantId_task_key`(`plantId`, `task`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_overrides` (
    `id` VARCHAR(191) NOT NULL,
    `plantId` VARCHAR(191) NOT NULL,
    `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES') NOT NULL,
    `nextDueOn` DATE NOT NULL,

    UNIQUE INDEX `task_overrides_plantId_task_key`(`plantId`, `task`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `due_caches` (
    `id` VARCHAR(191) NOT NULL,
    `plantId` VARCHAR(191) NOT NULL,
    `task` ENUM('WATER', 'FERTILIZE', 'REPOT', 'ROTATE', 'CLEAN_LEAVES') NOT NULL,
    `nextDueOn` DATE NOT NULL,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `due_caches_plantId_task_key`(`plantId`, `task`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `scheduled_moves` (
    `id` VARCHAR(191) NOT NULL,
    `ownerId` VARCHAR(191) NOT NULL,
    `targetCityId` VARCHAR(191) NOT NULL,
    `moveOn` DATE NOT NULL,
    `applied` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `scheduled_moves_ownerId_idx`(`ownerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `cities` ADD CONSTRAINT `cities_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `owners`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `places` ADD CONSTRAINT `places_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `owners`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `places` ADD CONSTRAINT `places_cityId_fkey` FOREIGN KEY (`cityId`) REFERENCES `cities`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plants` ADD CONSTRAINT `plants_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `owners`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plants` ADD CONSTRAINT `plants_placeId_fkey` FOREIGN KEY (`placeId`) REFERENCES `places`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plants` ADD CONSTRAINT `plants_speciesSlug_fkey` FOREIGN KEY (`speciesSlug`) REFERENCES `species`(`slug`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `care_events` ADD CONSTRAINT `care_events_plantId_fkey` FOREIGN KEY (`plantId`) REFERENCES `plants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plant_task_adjustments` ADD CONSTRAINT `plant_task_adjustments_plantId_fkey` FOREIGN KEY (`plantId`) REFERENCES `plants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_overrides` ADD CONSTRAINT `task_overrides_plantId_fkey` FOREIGN KEY (`plantId`) REFERENCES `plants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `due_caches` ADD CONSTRAINT `due_caches_plantId_fkey` FOREIGN KEY (`plantId`) REFERENCES `plants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

