import { writeFileSync } from 'node:fs';
import { loadEnv } from '../src/config/env.js';
import { buildDatabaseUrl } from '../src/config/database-url.js';

const env = loadEnv();
writeFileSync('.env', `DATABASE_URL=${buildDatabaseUrl(env)}\n`, 'utf8');
console.log('Wrote .env with composed DATABASE_URL');
