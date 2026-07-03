-- 0009_blogposts_and_media (hand-authored, data-preserving, forward-only).
--
-- Turns the per-species Markdown brief into a first-class Blogpost entity + adds a MediaAsset image
-- library. ORDER IS MANDATORY: (1) create the new tables, (2) backfill one PUBLISHED blogpost per
-- briefed species BEFORE dropping the brief columns, (3) drop the brief columns.
--
-- Backfill decisions:
--   * status = 1 (PUBLISHED): existing briefs are already public on the blog; this preserves
--     visibility. It is the ONE deliberate exception to "Claude creates drafts".
--   * slug = species.slug and species_slug = species.slug, so today's /blog/<species-slug> URLs survive.
--   * body_es = COALESCE(NULLIF(TRIM(brief_es),''), NULLIF(TRIM(brief_en),'')): ES leads; if a legacy
--     row has only brief_en it seeds body_es too so ES is never empty. body_es is NOT NULL.
--     Empty-string guard: brief_* are nullable TEXT with no non-empty constraint, so NULLIF(TRIM(..),'')
--     treats a whitespace-only brief as absent -> body_es is always genuine content.
--   * title_es = scientific_name (a safe, deterministic, always-present seed); title_en = NULL.
--     Editorial titles are refined later by editing the post; the migration's job is a lossless,
--     visible backfill, not perfect copy.
--   * excerpt_es = first ~200 chars of body_es (deterministic slice, never empty since body_es is
--     non-empty). excerpt_en = NULL.
--   * published_at = created_at = updated_at = NOW(3); created_by_user_id = NULL (no authoring user).
--   * Only species whose brief is non-empty AFTER trimming produce a row (the WHERE reuses the same
--     guard as body_es, so a selected row can never yield an empty body). A species with no/whitespace
--     brief yields NO blogpost — it was already brief-less and invisible on the blog; acceptable. The
--     knowledge-engine guarantees a blogpost per species going forward (Spec 2).
--
-- NOT trivially reversible: dropping the brief columns loses the column shape (the DATA survives in
-- `blogposts`). Down-migration is documented in prose per the repo's forward-only migrate-deploy history.

-- 1. Create the new tables.
CREATE TABLE `blogposts` (
  `slug`                    VARCHAR(191) NOT NULL,
  `status`                  INTEGER      NOT NULL DEFAULT 0,
  `species_slug`            VARCHAR(191) NULL,
  `title_es`                VARCHAR(191) NOT NULL,
  `title_en`                VARCHAR(191) NULL,
  `excerpt_es`              TEXT         NOT NULL,
  `excerpt_en`              TEXT         NULL,
  `body_es`                 TEXT         NOT NULL,
  `body_en`                 TEXT         NULL,
  `cover_image_url`         VARCHAR(191) NULL,
  `cover_image_object_key`  VARCHAR(191) NULL,
  `youtube_url`             VARCHAR(191) NULL,
  `cta_link`                VARCHAR(191) NULL,
  `cta_label_es`            VARCHAR(191) NULL,
  `cta_label_en`            VARCHAR(191) NULL,
  `created_by_user_id`      VARCHAR(191) NULL,
  `published_at`            DATETIME(3)  NULL,
  `created_at`              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`              DATETIME(3)  NOT NULL,
  UNIQUE INDEX `blogposts_species_slug_key`(`species_slug`),
  INDEX `blogposts_status_published_at_idx`(`status`, `published_at`),
  PRIMARY KEY (`slug`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `media_assets` (
  `id`                 VARCHAR(191) NOT NULL,
  `image_url`          VARCHAR(191) NOT NULL,
  `image_object_key`   VARCHAR(191) NOT NULL,
  `filename`           VARCHAR(191) NOT NULL,
  `size_bytes`         INTEGER      NOT NULL,
  `width`              INTEGER      NULL,
  `height`             INTEGER      NULL,
  `created_by_user_id` VARCHAR(191) NULL,
  `created_at`         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `media_assets_created_at_idx`(`created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `blogposts`
  ADD CONSTRAINT `blogposts_species_slug_fkey`
  FOREIGN KEY (`species_slug`) REFERENCES `species`(`slug`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Backfill one PUBLISHED blogpost per briefed species (BEFORE dropping the columns).
INSERT INTO `blogposts` (
  `slug`, `status`, `species_slug`,
  `title_es`, `title_en`,
  `excerpt_es`, `excerpt_en`,
  `body_es`, `body_en`,
  `created_by_user_id`, `published_at`, `created_at`, `updated_at`
)
SELECT
  s.`slug`,
  1,
  s.`slug`,
  s.`scientific_name`,
  NULL,
  LEFT(COALESCE(NULLIF(TRIM(s.`brief_es`), ''), NULLIF(TRIM(s.`brief_en`), '')), 200),
  NULL,
  COALESCE(NULLIF(TRIM(s.`brief_es`), ''), NULLIF(TRIM(s.`brief_en`), '')),
  NULLIF(TRIM(s.`brief_en`), ''),
  NULL,
  NOW(3),
  NOW(3),
  NOW(3)
FROM `species` s
WHERE COALESCE(NULLIF(TRIM(s.`brief_es`), ''), NULLIF(TRIM(s.`brief_en`), '')) IS NOT NULL;

-- 3. Drop the retired brief columns (data now lives in `blogposts`).
ALTER TABLE `species` DROP COLUMN `brief_en`;
ALTER TABLE `species` DROP COLUMN `brief_es`;
