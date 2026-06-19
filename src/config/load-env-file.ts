// Side-effect module: loads the local `.env` (DB_*, PORT, DEFAULT_CITY_TZ, WEB_ORIGIN) into
// `process.env` so the app boots regardless of how it is launched (`./run.sh`, `nest start`,
// `node dist/main.js`, vitest) — no manual `source .env` needed. `.env` is resolved relative
// to the process cwd, which npm/nest/vitest all set to this package's root.
//
// Note: this is the APP's config file. Prisma's generated `DATABASE_URL` lives separately in
// `prisma/.env` (written by `scripts/write-prisma-env.ts`), so the two never overwrite each other.
import { config } from 'dotenv';

config({ quiet: true }); // quiet: suppress dotenv v17's promotional startup banner
