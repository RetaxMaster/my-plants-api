// One-shot: migrate the curated species records from the flat `commonNames` list to the two per-locale
// lists (`commonNamesEn` / `commonNamesEs`). Run locally now; re-run in prod during the gated deploy.
// Idempotent: a record already migrated (no `commonNames`, has `commonNamesEn`) is skipped.
//
// Uses the project's canonical script wiring (load the app `.env`; Prisma reads the composed
// DATABASE_URL from `prisma/.env`) — same as scripts/create-user.ts. Run: `npm run prisma:env` first
// to refresh prisma/.env, then `tsx scripts/backfill-localized-common-names.ts`.
import '../src/config/load-env-file.js';
import { PrismaClient } from '@prisma/client';

// Curated per-species localized common names (English first by recognizability; Spanish real names).
const CURATED: Record<string, { en: string[]; es: string[] }> = {
  'dracaena-fragrans': {
    en: ['Corn plant', 'Cornstalk dracaena', 'Fragrant dracaena', 'Massangeana', 'Striped dracaena'],
    es: ['Palo de agua', 'Palo de Brasil', 'Tronco de Brasil', 'Maíz de agua'],
  },
  'dracaena-trifasciata': {
    en: ['Snake plant', "Mother-in-law's tongue", "Saint George's sword", 'Sansevieria'],
    es: ['Lengua de suegra', 'Lengua de tigre', 'Espada de San Jorge', 'Sansevieria'],
  },
  'epipremnum-aureum': {
    en: ['Pothos', 'Golden pothos', "Devil's ivy", 'Money plant', 'Ceylon creeper'],
    es: ['Potos', 'Poto', 'Hiedra del diablo'],
  },
  'nephrolepis-biserrata': {
    en: ['Giant sword fern', 'Broad sword fern', 'Macho fern', 'Roosevelt fern'],
    es: ['Helecho espada gigante', 'Helecho macho'],
  },
  'nephrolepis-exaltata': {
    en: ['Boston fern', 'Sword fern', 'Boston sword fern'],
    es: ['Helecho de Boston', 'Helecho espada'],
  },
};

async function main() {
  const prisma = new PrismaClient();
  try {
    for (const [slug, names] of Object.entries(CURATED)) {
      const row = await prisma.species.findUnique({ where: { slug } });
      if (!row) { console.warn(`skip: species not found: ${slug}`); continue; }
      const record = row.record as Record<string, unknown>;
      if (!('commonNames' in record) && 'commonNamesEn' in record) {
        console.log(`skip (already migrated): ${slug}`);
        continue;
      }
      delete record.commonNames;
      record.commonNamesEn = names.en;
      record.commonNamesEs = names.es;
      await prisma.species.update({ where: { slug }, data: { record: record as object } });
      console.log(`migrated: ${slug}  en=${names.en.length} es=${names.es.length}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
