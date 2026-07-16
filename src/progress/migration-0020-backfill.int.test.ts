// @vitest-environment node — real MariaDB, runs migration 0020's LITERAL backfill SQL against throwaway clones.
import { it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import '../config/load-env-file.js'; // load the app `.env` (DB_*) into process.env
import { loadDbEnv } from '../config/env.js';
import { buildDatabaseUrl } from '../config/database-url.js';

// Self-contained DB URL, assembled from the app's DB_* env exactly like PrismaService (no reliance on an
// ambient DATABASE_URL). The connection is fixed to UTC to honour the MariaDB date rule.
const db = new PrismaClient({ datasources: { db: { url: buildDatabaseUrl(loadDbEnv()) } } });
const raw = (sql: string) => db.$executeRawUnsafe(sql);

// Pull the two backfill statements VERBATIM from the migration file (single source of truth), then remap only
// the real table names to the throwaway clones — the pairing/prune logic is unchanged.
async function migrationBackfillStatements() {
  // ESM-safe path resolution: `my-plants-api` is "type": "module", so `__dirname` is undefined. Resolve the
  // migration relative to THIS test file via import.meta.url. This file lives at src/progress/, so the repo's
  // prisma/ is two levels up.
  const sql = await readFile(
    new URL('../../prisma/migrations/0020_progress_photo_async/migration.sql', import.meta.url), 'utf8');
  const pairing = sql.match(/UPDATE `care_events` ce[\s\S]*?WHERE ce\.task = 'PROGRESS';/)?.[0];
  const prune = sql.match(/DELETE FROM `care_events` WHERE task = 'PROGRESS' AND progress_entry_id IS NULL;/)?.[0];
  if (!pairing || !prune) throw new Error('could not extract 0020 backfill statements — did the migration change?');
  const retarget = (s: string) => s.replace(/`care_events`/g, '_bk_events').replace(/`plant_progress_entries`/g, '_bk_entries');
  return { pairing: retarget(pairing), prune: retarget(prune) };
}

beforeAll(async () => {
  // Throwaway clones (the local user has full rights inside `myplants`; it just can't create a new DB) with the
  // same columns the backfill SQL touches — and NO foreign keys, so no heavy plant/place seeding is needed.
  await raw(`DROP TABLE IF EXISTS _bk_events`); await raw(`DROP TABLE IF EXISTS _bk_entries`);
  await raw(`CREATE TABLE _bk_entries (id VARCHAR(191) PRIMARY KEY, plant_id VARCHAR(191), occurred_on DATE, created_at DATETIME(3))`);
  await raw(`CREATE TABLE _bk_events (id VARCHAR(191) PRIMARY KEY, plant_id VARCHAR(191), task VARCHAR(32), occurred_on DATE, created_at DATETIME(3), progress_entry_id VARCHAR(191) NULL)`);
  // Clean slate (all FK NULL). Plant P: TWO entries on the SAME date, distinct created_at → e1, e2.
  await raw(`INSERT INTO _bk_entries VALUES
    ('e1','P','2026-07-01','2026-07-01 08:00:00'),
    ('e2','P','2026-07-01','2026-07-01 09:00:00')`);
  // ev1, ev2 = duplicate-date PROGRESS events; evX = unpairable PROGRESS (its date has no entry).
  await raw(`INSERT INTO _bk_events VALUES
    ('ev1','P','PROGRESS','2026-07-01','2026-07-01 08:00:00',NULL),
    ('ev2','P','PROGRESS','2026-07-01','2026-07-01 09:00:00',NULL),
    ('evX','P','PROGRESS','2026-07-09','2026-07-09 08:00:00',NULL)`);
});

afterAll(async () => {
  await raw(`DROP TABLE IF EXISTS _bk_events`); await raw(`DROP TABLE IF EXISTS _bk_entries`);
  await db.$disconnect();
});

it('runs 0020\'s LITERAL backfill: duplicate-date events pair to DISTINCT entries; unpairable is pruned', async () => {
  const { pairing, prune } = await migrationBackfillStatements();
  await raw(pairing);
  await raw(prune);
  const rows = await db.$queryRawUnsafe<{ id: string; progress_entry_id: string | null }[]>(
    `SELECT id, progress_entry_id FROM _bk_events ORDER BY id`);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.progress_entry_id]));
  // ev1 → e1, ev2 → e2 by ROW_NUMBER (created_at order) — DISTINCT entries (@unique never violated).
  expect(byId.ev1).toBe('e1');
  expect(byId.ev2).toBe('e2');
  expect(byId.ev1).not.toBe(byId.ev2);
  // evX had no same-date entry → stayed NULL → pruned by the DELETE (not a null-FK straggler).
  expect(rows.find((r) => r.id === 'evX')).toBeUndefined();
});
