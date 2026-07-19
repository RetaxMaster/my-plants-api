import type { PrismaClient } from '@prisma/client';
import type { PlantProfile } from '@retaxmaster/my-plants-species-schema';
import type { ProgressTagKey } from '@retaxmaster/my-plants-species-schema/progress-tag-constants';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { cleanupOwners } from '../common/owner-teardown.js';

/**
 * The QA fixture: ONE known scenario, rebuilt from scratch on demand.
 *
 * This is deliberately NOT a seeder. A seeder ADDS rows, so running it twice doubles the data and QA
 * starts from a different world every time. This RESETS: it destroys everything the QA owner has and
 * rebuilds the same scenario, so running it ten times leaves exactly the state it left the first time.
 * That is what makes it safe to run both before and after a QA pass — there is no ordering to remember.
 *
 * ── Why the QA owner owns its own garden ─────────────────────────────────────────────────────────────
 * The standing QA account historically owned NO plants, so QA reached the developer's real plants by
 * impersonating them (ADMIN + `x-act-as-owner`), and a QA run destroyed a real progress entry. The
 * account keeps ADMIN — QA must stay free to exercise admin surfaces — but it now owns a complete garden
 * of its own, so it has no reason to reach for anyone else's. The blast radius of a reset is likewise
 * bounded to this one owner: `resetFixture` NEVER touches a row it does not own.
 *
 * The environment guard that stops this running against production lives in `scripts/qa-reset.ts`
 * (APP_ENV, fail-closed), not here — this module is pure mechanics and is unit-tested as such.
 */

export const QA_USERNAME = 'qa_fixture';
export const QA_PASSWORD = 'qatest1234';
export const QA_OWNER_NAME = 'qa_fixture';

/** Object keys the fixture creates live under this prefix, so its own objects are always identifiable. */
export const QA_OBJECT_PREFIX = 'qa-fixture';

export type ProgressSpec = {
  daysAgo: number;
  health: 'SICK' | 'POOR' | 'GOOD' | 'EXCELLENT';
  observations: string | null;
  /** Typed against the shared vocabulary — an invented key must not compile. */
  tags: ProgressTagKey[] | null;
  sizeCm: number | null;
  /** How many photos to attach. Satisfied only when an object store is available. */
  photos: number;
};

export type PlantSpec = {
  key: string;
  nickname: string;
  /** Resolved against the species actually present; falls back (loudly) when absent. */
  preferredSpecies: string;
  placeKey: 'window' | 'door';
  acquiredDaysAgo: number;
  /** Which shape of profile — the copilot's whole job is filling an empty one. */
  profile: 'complete' | 'partial' | 'empty';
  /** task → how many days ago it was last DONE. Absent task = never done. */
  lastDone: Partial<Record<'WATER' | 'FERTILIZE' | 'REPOT' | 'ROTATE' | 'CLEAN_LEAVES' | 'MIST', number>>;
  /** An explicit per-plant cadence override, so QA can exercise frequency editing / doctor proposals. */
  waterIntervalDays?: number;
  progress: ProgressSpec[];
  cover: boolean;
  /** Free-text note describing what this plant is FOR, printed in the briefing handed to QA. */
  purpose: string;
};

/**
 * The scenario. Four plants, each earning its place by covering a QA surface the others do not.
 *
 * Every date is expressed as "N days ago" and resolved at run time, never hardcoded. A fixture with
 * literal dates rots: it is correct the day it is written and silently wrong a week later, which is the
 * worst failure mode for test data — it still loads, it just no longer means what it says.
 *
 * "Up to date" uses 0 days ago and "overdue" uses 60. Those extremes are chosen so the outcome holds for
 * ANY species interval the care engine computes: nothing is due the day it was done, and nothing has a
 * 60-day watering cadence. Picking a number just inside a species' real interval would make the scenario
 * depend on the engine's constants, so a legitimate tuning change would quietly break QA's baseline.
 */
export const SCENARIO: PlantSpec[] = [
  {
    key: 'healthy',
    nickname: 'Fiona',
    preferredSpecies: 'epipremnum-aureum',
    placeKey: 'window',
    acquiredDaysAgo: 400,
    profile: 'complete',
    // Every task the engine schedules is anchored recently. A task with NO record is anchored to the
    // acquisition date instead, so an incomplete list here would silently make the "healthy" baseline
    // hundreds of days overdue on whatever was left out — which is exactly what happened first time.
    lastDone: { WATER: 0, FERTILIZE: 10, ROTATE: 3, CLEAN_LEAVES: 7, MIST: 1, REPOT: 200 },
    progress: [
      { daysAgo: 20, health: 'GOOD', observations: 'Steady growth, no issues.', tags: ['NEW_LEAF'], sizeCm: 34, photos: 0 },
      { daysAgo: 5, health: 'EXCELLENT', observations: 'Two new leaves unfurled this week.', tags: ['NEW_LEAF'], sizeCm: 38, photos: 1 },
    ],
    cover: true,
    purpose: 'The healthy baseline — everything up to date, profile complete. Nothing should be due.',
  },
  {
    key: 'blank-profile',
    nickname: 'Gus',
    preferredSpecies: 'dracaena-trifasciata',
    placeKey: 'window',
    acquiredDaysAgo: 90,
    profile: 'empty',
    lastDone: { WATER: 0, FERTILIZE: 5, ROTATE: 5, CLEAN_LEAVES: 5, MIST: 5 },
    progress: [],
    cover: false,
    purpose:
      'The copilot target — care is up to date, but the profile is entirely empty, there is no cover ' +
      'photo and there is no progress history at all, so the Plant Doctor has real gaps to propose ' +
      'filling. Its PROGRESS task reads overdue BY DESIGN: a plant nobody has ever journalled is ' +
      'exactly what an empty history looks like. Start diagnosis sessions here.',
  },
  {
    key: 'overdue',
    nickname: 'Nina',
    preferredSpecies: 'nephrolepis-exaltata',
    placeKey: 'door',
    acquiredDaysAgo: 200,
    profile: 'partial',
    // Uniformly stale, so "overdue" is a deliberate property of this plant rather than an accident of
    // whichever task happened to be omitted.
    lastDone: { WATER: 60, FERTILIZE: 60, ROTATE: 60, CLEAN_LEAVES: 60, MIST: 60 },
    waterIntervalDays: 4,
    progress: [
      { daysAgo: 30, health: 'GOOD', observations: 'Fronds looked full.', tags: null, sizeCm: 25, photos: 0 },
    ],
    cover: true,
    purpose:
      'The overdue case — watering and fertilizing 60 days stale, plus an explicit 4-day cadence ' +
      'override. Drives the red semaphore, the Today list, and cadence-change proposals.',
  },
  {
    key: 'declining',
    nickname: 'Otto',
    preferredSpecies: 'dracaena-fragrans',
    placeKey: 'door',
    acquiredDaysAgo: 600,
    profile: 'complete',
    // Routine care is current; the ONLY stale things are fertilizing and a badly overdue repot. That
    // isolation is the point — the declining health should point at the repot, not be drowned out by a
    // dozen incidental overdue chores.
    lastDone: { WATER: 2, FERTILIZE: 45, REPOT: 500, ROTATE: 4, CLEAN_LEAVES: 6, MIST: 2 },
    progress: [
      { daysAgo: 45, health: 'EXCELLENT', observations: 'Thriving after the move.', tags: ['NEW_LEAF'], sizeCm: 70, photos: 2 },
      { daysAgo: 25, health: 'GOOD', observations: 'Lower leaves yellowing slightly.', tags: ['YELLOWING_LEAVES'], sizeCm: 72, photos: 1 },
      { daysAgo: 6, health: 'POOR', observations: 'Yellowing has spread and the leaf edges are drying.', tags: ['YELLOWING_LEAVES', 'DRY_LEAVES'], sizeCm: 72, photos: 2 },
    ],
    cover: true,
    purpose:
      'The diagnosis target — a photographed history trending EXCELLENT → GOOD → POOR, last repotted ' +
      '500 days ago, and fertilizing the one overdue task. This is the plant to ask the doctor to ' +
      'actually diagnose.',
  },
];

// Typed as `PlantProfile` on purpose: the vocabularies are lowercase kebab slugs owned by the shared
// species-schema package, and a plausible-looking invention (`TERRACOTTA`, `AROID_MIX`) would otherwise
// persist happily and only surface as a broken dropdown during QA. The type makes the compiler the
// checker, and a future vocabulary change breaks the build here instead of silently rotting the fixture.
const COMPLETE_PROFILE: PlantProfile = {
  windowDistance: 'within-1m',
  growLight: false,
  potType: 'terracotta',
  potSizeCm: 18,
  hasDrainage: true,
  soilMix: 'aroid',
  growthHabit: 'upright',
  ageMonths: 24,
  nearHeater: false,
};

const PARTIAL_PROFILE: PlantProfile = {
  windowDistance: '2-to-3m',
  growLight: null,
  potType: 'plastic',
  potSizeCm: null,
  hasDrainage: false,
  soilMix: null,
  growthHabit: null,
  ageMonths: null,
  nearHeater: null,
};

/** A port over the object bucket, so the core stays testable without network or credentials. */
export type ObjectStore = {
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  delete(key: string): Promise<void>;
  urlFor(key: string): string;
};

export type ResetOptions = {
  /** Anchor for every relative date. Injected so tests are not at the mercy of the wall clock. */
  today: Date;
  /** Absent (or null) when the bucket is not configured — the scenario is then built without photos. */
  store: ObjectStore | null;
  /** Emits human-readable progress. Defaults to silence, which is what the unit tests want. */
  log?: (message: string) => void;
};

export type ResetSummary = {
  ownerId: string;
  userId: string;
  username: string;
  password: string;
  plants: Array<{ key: string; id: string; nickname: string; species: string; purpose: string }>;
  photosCreated: number;
  photosSkippedReason: string | null;
  speciesFallbacks: string[];
};

/** UTC-midnight date `n` days before the anchor. DATE columns are bare calendar days; keeping every
 *  value at UTC midnight is what stops a timezone offset shifting a due-date threshold (the MariaDB
 *  date rule). Arithmetic is done on the epoch, so no DST transition can move a boundary. */
export function daysAgoUtc(anchor: Date, n: number): Date {
  const midnight = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  return new Date(midnight - n * 86_400_000);
}

/**
 * Resolves each spec's preferred species against what the database actually holds.
 *
 * Species records are curated by the knowledge engine, never seeded by this repo, so the exact set
 * differs per machine. The fixture insists on REAL records: a species with an empty `record` would make
 * the care engine compute meaningless schedules, and QA would then be validating a scenario that cannot
 * occur in production. When a preferred slug is missing we fall back to another real species and SAY SO
 * — a silent substitution would leave QA reasoning about the wrong plant.
 */
export function resolveSpecies(
  specs: PlantSpec[],
  available: string[],
): { bySpecKey: Map<string, string>; fallbacks: string[] } {
  if (available.length === 0) {
    throw new Error(
      'No species rows found. The QA fixture needs at least one curated species — species are produced ' +
        'by the knowledge engine, not by this repo. Restore a database dump or curate a species first.',
    );
  }
  const bySpecKey = new Map<string, string>();
  const fallbacks: string[] = [];
  specs.forEach((spec, i) => {
    if (available.includes(spec.preferredSpecies)) {
      bySpecKey.set(spec.key, spec.preferredSpecies);
    } else {
      const substitute = available[i % available.length];
      bySpecKey.set(spec.key, substitute);
      fallbacks.push(`${spec.nickname}: ${spec.preferredSpecies} not present, using ${substitute}`);
    }
  });
  return { bySpecKey, fallbacks };
}

/**
 * Destroys everything the QA owner has and rebuilds the scenario. Idempotent by construction.
 */
export async function resetFixture(prisma: PrismaClient, opts: ResetOptions): Promise<ResetSummary> {
  const log = opts.log ?? (() => {});

  // ── 1. Tear down whatever the QA owner currently has ────────────────────────────────────────────
  const existing = await prisma.owner.findFirst({
    where: { name: QA_OWNER_NAME },
    include: { user: true },
  });

  if (existing) {
    // Collect the QA owner's object keys BEFORE the rows go, or the keys are unrecoverable and every
    // object it ever owned is orphaned in the bucket. This covers photos QA uploaded during a run, not
    // just the ones the fixture created — which is the whole point of resetting after a pass.
    const keys = await qaOwnedObjectKeys(prisma, existing.id);
    log(`Removing the previous fixture (${keys.length} bucket object(s) to clean).`);
    if (opts.store) {
      for (const key of keys) {
        // Best-effort, mirroring the app's own delete semantics: a bucket hiccup must not strand the
        // reset half-done, leaving QA with no scenario at all.
        await opts.store.delete(key).catch(() => {});
      }
    }
    await cleanupOwners(prisma, [existing.id], existing.user ? [existing.user.id] : []);
  }

  // ── 2. Rebuild ──────────────────────────────────────────────────────────────────────────────────
  const availableSpecies = (await prisma.species.findMany({ select: { slug: true } })).map((s) => s.slug);
  const { bySpecKey, fallbacks } = resolveSpecies(SCENARIO, availableSpecies);

  const owner = await prisma.owner.create({ data: { name: QA_OWNER_NAME } });
  const user = await prisma.user.create({
    data: {
      username: QA_USERNAME,
      // Cost 12 matches `create-user.core.ts`, the real account-creation path. The e2e helper uses 10
      // for speed; this fixture backs an account a human logs into, so it follows the real one.
      passwordHash: await bcrypt.hash(QA_PASSWORD, 12),
      role: 'ADMIN',
      ownerId: owner.id,
    },
  });

  const city = await prisma.city.create({
    data: {
      ownerId: owner.id,
      name: 'QA City',
      latitude: 19.43,
      longitude: -99.13,
      timezone: 'America/Mexico_City',
      isPrimary: true,
    },
  });

  const places = {
    window: await prisma.place.create({
      data: {
        ownerId: owner.id,
        cityId: city.id,
        name: 'QA - Bright window',
        indoor: true,
        lightType: 'BRIGHT_INDIRECT',
        humidityCharacter: 'NORMAL',
        climateControlled: false,
      },
    }),
    door: await prisma.place.create({
      data: {
        ownerId: owner.id,
        cityId: city.id,
        name: 'QA - Shaded corner',
        indoor: true,
        lightType: 'MEDIUM',
        humidityCharacter: 'DRY',
        climateControlled: true,
      },
    }),
  };

  // Source objects for the fixture's photos: real, already-uploaded images belonging to ANYONE ELSE.
  // They are COPIED to fresh keys, never referenced in place — two rows pointing at one object would
  // mean deleting the QA entry also deletes the real plant's photo from the bucket, and the app really
  // does issue a DeleteObjectCommand on that path.
  const sourceKeys = opts.store ? await donorObjectKeys(prisma, owner.id) : [];
  const photosWanted = SCENARIO.reduce((n, p) => n + p.progress.reduce((m, e) => m + e.photos, 0), 0);
  let photosSkippedReason: string | null = null;
  if (!opts.store) {
    photosSkippedReason = 'the object bucket is not configured (R2_* env vars are empty)';
  } else if (sourceKeys.length === 0) {
    photosSkippedReason = 'no existing READY photo was found in the database to copy from';
  }

  let photosCreated = 0;
  const plants: ResetSummary['plants'] = [];

  for (const spec of SCENARIO) {
    const speciesSlug = bySpecKey.get(spec.key)!;
    const place = places[spec.placeKey];

    let coverImageUrl: string | null = null;
    let coverImageObjectKey: string | null = null;
    if (spec.cover && opts.store && sourceKeys.length > 0) {
      const key = `${QA_OBJECT_PREFIX}/${randomUUID()}.webp`;
      await opts.store.copy(sourceKeys[photosCreated % sourceKeys.length], key);
      coverImageUrl = opts.store.urlFor(key);
      coverImageObjectKey = key;
      photosCreated += 1;
    }

    const plant = await prisma.plant.create({
      data: {
        ownerId: owner.id,
        placeId: place.id,
        speciesSlug,
        nickname: spec.nickname,
        acquiredOn: daysAgoUtc(opts.today, spec.acquiredDaysAgo),
        coverImageUrl,
        coverImageObjectKey,
      },
    });

    if (spec.profile !== 'empty') {
      await prisma.plantProfile.create({
        data: {
          plantId: plant.id,
          ...(spec.profile === 'complete' ? COMPLETE_PROFILE : PARTIAL_PROFILE),
        },
      });
    }

    for (const [task, daysAgo] of Object.entries(spec.lastDone)) {
      await prisma.careEvent.create({
        data: {
          plantId: plant.id,
          task: task as never,
          type: 'DONE',
          occurredOn: daysAgoUtc(opts.today, daysAgo as number),
        },
      });
    }

    if (spec.waterIntervalDays !== undefined) {
      await prisma.plantTaskFrequency.create({
        data: { plantId: plant.id, task: 'WATER', intervalDays: spec.waterIntervalDays },
      });
    }

    for (const entry of spec.progress) {
      const created = await prisma.plantProgressEntry.create({
        data: {
          plantId: plant.id,
          occurredOn: daysAgoUtc(opts.today, entry.daysAgo),
          health: entry.health,
          observations: entry.observations,
          sizeCm: entry.sizeCm,
          tags: entry.tags ?? undefined,
        },
      });

      // The app never creates a progress entry alone: `progress.write-core.ts` also writes a paired
      // PROGRESS DONE care event carrying `progressEntryId`, and that event is what the care engine reads
      // to know the plant has been journalled. Writing the entry by itself produced a fixture where a
      // freshly-photographed plant still reported PROGRESS hundreds of days overdue — the rows existed,
      // the engine just could not see them. Mirroring the real write keeps the scenario honest.
      await prisma.careEvent.create({
        data: {
          plantId: plant.id,
          task: 'PROGRESS',
          type: 'DONE',
          occurredOn: daysAgoUtc(opts.today, entry.daysAgo),
          progressEntryId: created.id,
        },
      });

      if (opts.store && sourceKeys.length > 0) {
        for (let i = 0; i < entry.photos; i += 1) {
          const key = `${QA_OBJECT_PREFIX}/${randomUUID()}.webp`;
          await opts.store.copy(sourceKeys[photosCreated % sourceKeys.length], key);
          await prisma.plantProgressPhoto.create({
            data: {
              entryId: created.id,
              imageUrl: opts.store.urlFor(key),
              imageObjectKey: key,
              status: 'READY',
              sortOrder: i,
            },
          });
          photosCreated += 1;
        }
      }
    }

    log(`  ${spec.nickname} (${speciesSlug}) — ${spec.purpose.split('—')[0].trim()}`);
    plants.push({
      key: spec.key,
      id: plant.id,
      nickname: spec.nickname,
      species: speciesSlug,
      purpose: spec.purpose,
    });
  }

  if (photosSkippedReason && photosWanted > 0) {
    log(`Photos skipped: ${photosSkippedReason}.`);
  }

  return {
    ownerId: owner.id,
    userId: user.id,
    username: QA_USERNAME,
    password: QA_PASSWORD,
    plants,
    photosCreated,
    photosSkippedReason: photosWanted > 0 ? photosSkippedReason : null,
    speciesFallbacks: fallbacks,
  };
}

/** Every bucket key reachable from the QA owner's rows — progress photos and plant covers alike. */
async function qaOwnedObjectKeys(prisma: PrismaClient, ownerId: string): Promise<string[]> {
  const photos = await prisma.plantProgressPhoto.findMany({
    where: { entry: { plant: { ownerId } } },
    select: { imageObjectKey: true },
  });
  const covers = await prisma.plant.findMany({
    where: { ownerId },
    select: { coverImageObjectKey: true },
  });
  return [
    ...photos.map((p) => p.imageObjectKey),
    ...covers.map((c) => c.coverImageObjectKey),
  ].filter((k): k is string => Boolean(k));
}

/** Real, READY photos belonging to someone other than the QA owner — the copy sources. */
async function donorObjectKeys(prisma: PrismaClient, excludeOwnerId: string): Promise<string[]> {
  const rows = await prisma.plantProgressPhoto.findMany({
    where: {
      status: 'READY',
      imageObjectKey: { not: null },
      entry: { plant: { ownerId: { not: excludeOwnerId } } },
    },
    select: { imageObjectKey: true },
    take: 12,
  });
  return rows.map((r) => r.imageObjectKey).filter((k): k is string => Boolean(k));
}
