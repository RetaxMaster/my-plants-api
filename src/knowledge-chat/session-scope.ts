import type { Prisma } from '@prisma/client';

// How a caller is allowed to see chat sessions. KNOWLEDGE = the admin KE surface (kind-only). DOCTOR = an
// owner diagnosing ONE plant: the tuple (kind=DOCTOR, plantId, ownerId) is the access boundary (Spec 3 §3.2).
// One scope argument threaded through the shared service is what lets ONE service serve both controllers.
export type SessionScope =
  | { kind: 'KNOWLEDGE' }
  | { kind: 'DOCTOR'; plantId: string; ownerId: string };

// The list/where fragment for a scope.
export function whereForScope(scope: SessionScope): Prisma.KnowledgeChatSessionWhereInput {
  return scope.kind === 'DOCTOR'
    ? { kind: 'DOCTOR', plantId: scope.plantId, ownerId: scope.ownerId }
    : { kind: 'KNOWLEDGE' };
}

// True iff a loaded session row belongs to this scope. Used by every by-id operation so an id from another
// plant/owner/kind is indistinguishable from "not found" (Spec 3 §3.2 cross-plant 404).
export function sessionMatchesScope(
  session: { kind: string; plantId: string | null; ownerId: string | null },
  scope: SessionScope,
): boolean {
  if (scope.kind === 'KNOWLEDGE') return session.kind === 'KNOWLEDGE';
  return session.kind === 'DOCTOR' && session.plantId === scope.plantId && session.ownerId === scope.ownerId;
}
