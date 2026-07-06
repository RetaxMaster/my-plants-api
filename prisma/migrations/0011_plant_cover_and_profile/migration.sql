-- 0011_plant_cover_and_profile (hand-authored, additive, forward-only).
--
-- Adds a plant COVER photo (two nullable columns on `plants`, mirroring the Blogpost cover
-- convention: url + retained R2 object key so a later replace/delete can remove the old object) and a
-- 1:1 `plant_profiles` table holding a plant's optional physical profile (Spec 1 vocabulary). Enum-
-- valued columns store the VALIDATED slug as a plain string — the Zod enum in
-- @retaxmaster/my-plants-species-schema is the single source of truth, so no DB enum duplicates it.
--
-- Purely additive: two ADD COLUMN + one CREATE TABLE + one FK. No data transform, no backfill.
-- `plant_profiles` cascade-deletes with its plant (ON DELETE CASCADE). This feature adds NO new
-- date-threshold query, so the MariaDB date/time rule has no new surface here.
--
-- Authoring: generated with `prisma migrate diff --from-url "$DATABASE_URL"
-- --to-schema-datamodel prisma/schema.prisma --script` and reviewed by hand (the repo cannot run
-- `migrate dev` — the shadow DB is denied for the local user; see memory
-- api-migrations-hand-authored-deploy). The raw diff also emitted a spurious DROP/ADD of every
-- existing foreign key (an introspection artifact: `migrate diff --from-url` cannot recover the live
-- DB's referential actions exactly, so it re-states unchanged FKs); `migrate status` confirms the DB
-- is in sync through 0010, so that churn is dropped and only the real additive delta is kept. Applied
-- with `npm run prisma:migrate` (prisma migrate deploy).
--
-- NOT trivially reversible via this file: dropping `plant_profiles` and the two columns reverses it;
-- down-migration is prose per the repo's forward-only migrate-deploy history.

-- 1. Plant cover photo (nullable; object key retained for replace/delete cleanup).
ALTER TABLE `plants`
  ADD COLUMN `cover_image_url` VARCHAR(191) NULL,
  ADD COLUMN `cover_image_object_key` VARCHAR(191) NULL;

-- 2. 1:1 plant profile (one row per plant, created lazily on first PATCH).
CREATE TABLE `plant_profiles` (
  `plant_id`        VARCHAR(191) NOT NULL,
  `window_distance` VARCHAR(191) NULL,
  `grow_light`      BOOLEAN      NULL,
  `pot_type`        VARCHAR(191) NULL,
  `pot_size_cm`     INTEGER      NULL,
  `has_drainage`    BOOLEAN      NULL,
  `soil_mix`        VARCHAR(191) NULL,
  `growth_habit`    VARCHAR(191) NULL,
  `age_months`      INTEGER      NULL,
  `near_heater`     BOOLEAN      NULL,
  `updated_at`      DATETIME(3)  NOT NULL,
  PRIMARY KEY (`plant_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `plant_profiles`
  ADD CONSTRAINT `plant_profiles_plant_id_fkey`
  FOREIGN KEY (`plant_id`) REFERENCES `plants`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
