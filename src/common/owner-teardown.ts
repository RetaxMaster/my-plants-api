import type { PrismaClient } from '@prisma/client';

/**
 * Removing every row belonging to a set of owners, in foreign-key-safe order.
 *
 * This lived in `test/helpers/boot.ts` while the e2e suite was its only caller. The QA fixture reset
 * (`npm run qa:reset`) needs the exact same operation, and copying it would have created two teardowns
 * that drift — the workspace's fork-prevention rule. It moved here, to `src/`, so BOTH callers share one
 * implementation; `test/helpers/boot.ts` now re-exports it rather than owning it.
 *
 * `PrismaService` extends `PrismaClient`, so the Nest-injected service and a plain script-constructed
 * client both satisfy this signature.
 */

/**
 * Every table holding a foreign key straight to `plants.id`, discovered from the SCHEMA ITSELF via
 * `information_schema.KEY_COLUMN_USAGE` rather than hand-maintained. A hand-written list is invisible to
 * a table nobody remembered to add — which is exactly how `due_caches` leaked four owners into the
 * shared local dev database: the post-commit care-plan recompute (and, locally, every `nest start
 * --watch` restart's startup recompute — see `src/startup/startup.service.ts`) writes a due-cache row for
 * every plant in the database, `due_caches` was missing from the old hand list, and the plant delete
 * below silently failed for every run whose plant was still present when a recompute fired. Re-derived
 * on every call so a NEW model with a plant FK is covered automatically, with no second list to update.
 */
export async function tablesReferencingPlants(
  prisma: PrismaClient,
): Promise<Array<{ table: string; column: string }>> {
  const rows = await prisma.$queryRaw<Array<{ TABLE_NAME: string; COLUMN_NAME: string }>>`
    SELECT DISTINCT TABLE_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'plants' AND REFERENCED_COLUMN_NAME = 'id'`;
  return rows.map((r) => ({ table: r.TABLE_NAME, column: r.COLUMN_NAME }));
}

/** Removes every row a booted suite (or the QA fixture) created for these owners, in FK-safe order. */
export async function cleanupOwners(
  prisma: PrismaClient,
  ownerIds: string[],
  userIds: string[],
): Promise<void> {
  if (ownerIds.length === 0 && userIds.length === 0) return;

  await prisma.knowledgeChatSession.deleteMany({ where: { ownerId: { in: ownerIds } } }).catch(() => {});

  const fkTables = await tablesReferencingPlants(prisma);

  for (const oid of ownerIds) {
    // Every delete below still swallows its own error so one unexpected/renamed table cannot stop the
    // rest from being attempted — but swallowing ALL of them is exactly what made the original leak
    // invisible. The verification after this loop is what makes a real leftover LOUD instead of silent.
    for (const { table, column } of fkTables) {
      // `table`/`column` come from information_schema, never from caller input — only `oid` is a bound
      // parameter — so this is not a SQL-injection surface.
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM \`${table}\` WHERE \`${column}\` IN (SELECT id FROM plants WHERE owner_id = ?)`,
          oid,
        )
        .catch(() => {});
    }
    await prisma.plant.deleteMany({ where: { ownerId: oid } }).catch(() => {});
    await prisma.place.deleteMany({ where: { ownerId: oid } }).catch(() => {});
    await prisma.city.deleteMany({ where: { ownerId: oid } }).catch(() => {});
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await prisma.owner.deleteMany({ where: { id: { in: ownerIds } } }).catch(() => {});

  // A silent leak is the same family as a silent test failure (2026-07-18 ledger, "the suite leaked
  // fixtures"): verify the owners are ACTUALLY gone and fail loudly, naming the survivors, instead of
  // letting every `.catch(() => {})` above hide a real leftover row.
  const survivors = await prisma.owner.findMany({
    where: { id: { in: ownerIds } },
    select: { id: true, name: true },
  });
  if (survivors.length > 0) {
    throw new Error(
      `cleanupOwners left ${survivors.length} owner(s) behind: ` +
        `${survivors.map((s) => `${s.id} (${s.name})`).join(', ')}. A row referencing one of their ` +
        `plants/places/cities is still blocking the delete — check for a new foreign key to ` +
        `plants/places/cities/owners that this cleanup does not yet cover.`,
    );
  }
}
