-- 0010_blogpost_cover_image_prompt (hand-authored, data-transforming, forward-only).
--
-- Gives the cover-image (OG) generation prompt its own column instead of smuggling it inside body_es.
-- ORDER IS MANDATORY: (1) add the nullable column, (2) backfill by EXTRACTING the legacy
-- `<!-- THUMBNAIL-PROMPT … THUMBNAIL-PROMPT -->` block out of every body_es into the new column and
-- STRIPPING it from body_es.
--
-- Legacy delimiters (frozen literals — a migration is a historical artifact and must NOT depend on a
-- package whose exports keep changing; the shared constants that once held these were removed in the
-- 0.6.0 schema release):
--   open  = '<!-- THUMBNAIL-PROMPT'
--   close = 'THUMBNAIL-PROMPT -->'
--
-- Backfill mechanism — deterministic LOCATE/SUBSTRING to LOCATE and cut the block (NOT regex parsing:
-- the block is a single contiguous run bounded by the two literal delimiters at the TOP of body_es;
-- SUBSTRING/LOCATE handle multi-line text natively — no dot-all, no escaping — and are far less brittle
-- than trying to REGEXP-match the whole block). CHAR_LENGTH (not LENGTH) is used for the delimiter
-- lengths so multibyte body text keeps every offset in CHARACTER units, consistent with LOCATE/SUBSTRING
-- (also character-based in MariaDB).
--
-- WHITESPACE TRIM — REGEXP_REPLACE, NOT TRIM(). MariaDB's bare TRIM() strips ONLY spaces (0x20); it does
-- NOT strip newlines, carriage returns, or tabs. The block is delimited by newlines (and may be CRLF),
-- so we normalize the extracted prompt and the stripped body with
-- REGEXP_REPLACE(x, '^[[:space:]]+|[[:space:]]+$', '') — a whitespace-only trim on BOTH ends (POSIX
-- [[:space:]] covers space, \t, \n, \r). This is regex used purely as a trimmer, not to parse the block.
-- REGEXP_REPLACE in MariaDB is global by default, so one call cleans both ends.
--
-- SET-ORDER HAZARD (why cover_image_prompt is assigned BEFORE body_es): MariaDB evaluates UPDATE SET
-- items left-to-right and a later item sees the NEW value of an earlier-assigned column. cover_image_prompt
-- reads body_es, so it MUST be assigned first (while body_es is still the OLD value that contains the
-- block); body_es is stripped second, reading its own still-OLD value. Reversing the order would make
-- the extraction read an already-stripped body and produce NULL.
--
-- WHERE guard (idempotency + safety): fires only when BOTH delimiters are present AND close is after
-- open. After the UPDATE runs, no row still contains the block, so a re-run matches nothing (idempotent).
-- A malformed half-block (only an opener, or close-before-open) is left UNTOUCHED for manual review and
-- never yields a garbage prompt.
--
-- Edge cases covered: CRLF vs LF (the REGEXP_REPLACE trim strips \r and \n; LOCATE/CHAR_LENGTH are
-- newline-agnostic); an empty/whitespace prompt body -> after the trim it is '' -> NULLIF(..,'') yields
-- NULL (never '' — that would violate the contract's min(1));
-- multiple blocks -> only the first pair is handled (historically there is never more than one — the
-- writer prepends exactly one); a row whose block is absent -> skipped by the WHERE.
--
-- NOT rerunnable in full: ADD COLUMN is one-shot (only the UPDATE is idempotent). NOT trivially
-- reversible: dropping the column would lose the extracted prompts (they were stripped from body_es).
-- Down-migration is documented in prose per the repo's forward-only migrate-deploy history.

-- 1. Add the nullable column.
ALTER TABLE `blogposts`
  ADD COLUMN `cover_image_prompt` TEXT NULL AFTER `cover_image_object_key`;

-- 2. Extract the legacy block into the new column AND strip it from body_es (single UPDATE).
UPDATE `blogposts`
SET
  `cover_image_prompt` = NULLIF(
    REGEXP_REPLACE(
      SUBSTRING(
        `body_es`,
        LOCATE('<!-- THUMBNAIL-PROMPT', `body_es`) + CHAR_LENGTH('<!-- THUMBNAIL-PROMPT'),
        LOCATE('THUMBNAIL-PROMPT -->', `body_es`)
          - (LOCATE('<!-- THUMBNAIL-PROMPT', `body_es`) + CHAR_LENGTH('<!-- THUMBNAIL-PROMPT'))
      ),
      '^[[:space:]]+|[[:space:]]+$', ''
    ),
    ''
  ),
  `body_es` = REGEXP_REPLACE(
    CONCAT(
      SUBSTRING(`body_es`, 1, LOCATE('<!-- THUMBNAIL-PROMPT', `body_es`) - 1),
      SUBSTRING(
        `body_es`,
        LOCATE('THUMBNAIL-PROMPT -->', `body_es`) + CHAR_LENGTH('THUMBNAIL-PROMPT -->')
      )
    ),
    '^[[:space:]]+|[[:space:]]+$', ''
  )
WHERE `body_es` LIKE '%<!-- THUMBNAIL-PROMPT%'
  AND `body_es` LIKE '%THUMBNAIL-PROMPT -->%'
  AND LOCATE('THUMBNAIL-PROMPT -->', `body_es`) > LOCATE('<!-- THUMBNAIL-PROMPT', `body_es`);
