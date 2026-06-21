CREATE TABLE `users` (
  `id`            VARCHAR(191) NOT NULL,
  `username`      VARCHAR(191) NOT NULL,
  `password_hash` VARCHAR(191) NOT NULL,
  `role`          ENUM('USER','ADMIN') NOT NULL DEFAULT 'USER',
  `owner_id`      VARCHAR(191) NOT NULL,
  `created_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `users_username_key`(`username`),
  UNIQUE INDEX `users_owner_id_key`(`owner_id`),
  PRIMARY KEY (`id`),
  CONSTRAINT `users_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `revoked_tokens` (
  `jti`        VARCHAR(191) NOT NULL,
  `expires_at` DATETIME(3)  NOT NULL,
  INDEX `revoked_tokens_expires_at_idx`(`expires_at`),
  PRIMARY KEY (`jti`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
