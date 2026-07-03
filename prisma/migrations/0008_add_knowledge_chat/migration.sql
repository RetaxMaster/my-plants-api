-- Admin knowledge-engine chat: multi-session, resumable, persistent history for the embedded
-- realtime engine. Three tables adapted from retaxmaster-workspace (trimmed — one knowledge engine).
-- The composite UNIQUE (session_id, active_key) is load-bearing: with MariaDB's null-exempt unique
-- semantics it DB-enforces "at most ONE active run per session" atomically (a second active insert
-- hits the unique constraint → 409); `active_key` is cleared to NULL on every terminal transition.

-- One conversation = a thread of runs, addressed by our internal cuid `id`. `claude_session_id` is
-- Claude's own UUID (null until the first run inits) — stored only to pass back as --resume.
CREATE TABLE `knowledge_chat_sessions` (
    `id`                 VARCHAR(191) NOT NULL,
    `claude_session_id`  VARCHAR(191) NULL,
    `title`              VARCHAR(191) NOT NULL,
    `created_by_user_id` VARCHAR(191) NULL,
    `created_at`         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`         DATETIME(3)  NOT NULL,

    UNIQUE INDEX `knowledge_chat_sessions_claude_session_id_key`(`claude_session_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One run = one turn = one `claude -p` invocation (its id doubles as the engine runId + NDJSON
-- filename). `active_key` holds 'ACTIVE' while non-terminal, NULL once terminal (the unique slot).
CREATE TABLE `knowledge_chat_runs` (
    `id`              VARCHAR(191) NOT NULL,
    `session_id`      VARCHAR(191) NOT NULL,
    `prompt`          TEXT         NOT NULL,
    `status`          ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `active_key`      VARCHAR(191) NULL,
    `pid`             INTEGER      NULL,
    `proc_start_time` VARCHAR(191) NULL,
    `exit_code`       INTEGER      NULL,
    `error`           TEXT         NULL,
    `started_at`      DATETIME(3)  NULL,
    `finished_at`     DATETIME(3)  NULL,
    `created_at`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `knowledge_chat_runs_session_id_idx`(`session_id`),
    UNIQUE INDEX `knowledge_chat_runs_session_id_active_key_key`(`session_id`, `active_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Single-use socket ticket: only sha256(raw) is stored; the raw token is returned once to the browser.
CREATE TABLE `knowledge_chat_tickets` (
    `id`          VARCHAR(191) NOT NULL,
    `run_id`      VARCHAR(191) NOT NULL,
    `token_hash`  VARCHAR(191) NOT NULL,
    `expires_at`  DATETIME(3)  NOT NULL,
    `consumed_at` DATETIME(3)  NULL,
    `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `knowledge_chat_tickets_token_hash_key`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Cascades: deleting a session purges its runs; deleting a run purges its tickets.
ALTER TABLE `knowledge_chat_runs` ADD CONSTRAINT `knowledge_chat_runs_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `knowledge_chat_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `knowledge_chat_tickets` ADD CONSTRAINT `knowledge_chat_tickets_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `knowledge_chat_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
