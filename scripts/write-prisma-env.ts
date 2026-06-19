import { writeFileSync } from 'node:fs';
import '../src/config/load-env-file.js'; // load the app `.env` so DB_* are available here
import { loadEnv } from '../src/config/env.js';
import { buildDatabaseUrl } from '../src/config/database-url.js';

// The app's config lives in `.env` (DB_*). Prisma's CLI needs a composed DATABASE_URL, which we
// write to `prisma/.env` (Prisma auto-loads the `.env` next to schema.prisma). Keeping it in a
// separate file means regenerating it never clobbers the app's `.env`.
const env = loadEnv();
writeFileSync('prisma/.env', `DATABASE_URL=${buildDatabaseUrl(env)}\n`, 'utf8');
console.log('Wrote prisma/.env with composed DATABASE_URL');
