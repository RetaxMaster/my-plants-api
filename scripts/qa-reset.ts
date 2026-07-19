import '../src/config/load-env-file.js';
import { CopyObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { CarePlanService } from '../src/care-plan/care-plan.service.js';
import { WeatherService } from '../src/weather/weather.service.js';
import { OpenMeteoClient } from '../src/weather/open-meteo.client.js';
import { loadDbEnv } from '../src/config/env.js';
import { buildDatabaseUrl } from '../src/config/database-url.js';
import { assertDevelopmentEnv } from '../src/qa-fixture/qa-fixture.guard.js';
import { resetFixture, type ObjectStore } from '../src/qa-fixture/qa-fixture.core.js';

/**
 * `npm run qa:reset` — rebuild the QA scenario from scratch.
 *
 * Run it whenever you want a known world: before a QA pass to get a clean baseline, after one to undo
 * whatever QA did. It is idempotent, so there is no ordering to remember and no way to "run it twice by
 * mistake". It only ever touches rows owned by the QA fixture owner.
 */

/** The real object bucket, or null when R2 is not configured (the fixture then builds without photos). */
function makeStore(): ObjectStore | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_BASE_URL) {
    return null;
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  const base = R2_PUBLIC_BASE_URL.replace(/\/$/, '');

  return {
    // Server-side copy: the bytes never travel through this process. Copying rather than re-pointing is
    // deliberate — two rows sharing one object would mean deleting the QA copy also destroys the
    // original plant's photo, and the app really does issue a DeleteObjectCommand on that path.
    copy: async (sourceKey, destinationKey) => {
      await client.send(
        new CopyObjectCommand({
          Bucket: R2_BUCKET,
          Key: destinationKey,
          CopySource: `${R2_BUCKET}/${sourceKey}`,
        }),
      );
    },
    delete: async (key) => {
      await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    },
    // The URL is stored ABSOLUTE on the row (matching how the app persists uploads), so it must be built
    // from THIS environment's public base — never inherited from wherever the source object came from.
    urlFor: (key) => `${base}/${key}`,
  };
}

async function main() {
  // Before anything else, and before a single connection is opened.
  assertDevelopmentEnv();

  const dbEnv = loadDbEnv();
  const prisma = new PrismaService(buildDatabaseUrl(dbEnv));
  // Connects AND pins the session timezone to UTC — the DATE columns this fixture writes depend on it.
  await prisma.onModuleInit();

  const store = makeStore();

  try {
    console.log(`Resetting the QA fixture on ${dbEnv.DB_NAME}@${dbEnv.DB_HOST}…\n`);

    const summary = await resetFixture(prisma, {
      today: new Date(),
      store,
      log: (m) => console.log(m),
    });

    // The care engine caches every due date, and `GET /care-plan/today` reads that cache WITHOUT
    // recomputing on demand. Skipping this would leave the freshly built plants missing from the Today
    // screen — the single most important QA surface — so the fixture is not finished until the REAL
    // engine has run over it. Weather is the real service: it never throws and degrades to null offline.
    const carePlan = new CarePlanService(prisma, new WeatherService(new OpenMeteoClient()));
    await carePlan.recomputeOwner(summary.ownerId);

    const due = await carePlan.todaysTasks(summary.ownerId);

    console.log('\n─────────────────────────────────────────────────────────');
    console.log(`  Sign in as  ${summary.username} / ${summary.password}   (ADMIN)`);
    console.log('─────────────────────────────────────────────────────────\n');
    for (const p of summary.plants) {
      console.log(`  • ${p.nickname} (${p.species})`);
      console.log(`      ${p.purpose}\n`);
    }
    console.log(`  Photos created: ${summary.photosCreated}`);
    if (summary.photosSkippedReason) {
      console.log(`  ⚠ Photos were skipped — ${summary.photosSkippedReason}.`);
    }
    for (const f of summary.speciesFallbacks) {
      console.log(`  ⚠ Species substitution — ${f}`);
    }
    console.log(`  Tasks due today or overdue: ${due.length}`);
    console.log('\nDone. Re-run this command any time to return to exactly this state.');
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((e) => {
  console.error(`\n${e.message ?? e}\n`);
  process.exit(1);
});
