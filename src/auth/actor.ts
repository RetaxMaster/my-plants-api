// The authenticated actor for the current request, written into CLS by the JwtAuthGuard and read
// by OwnerService. `username` travels in the JWT payload (Phase 2) and rides along here so request
// handlers (e.g. GET /auth/me) can echo it without another DB read.
export interface Actor {
  userId: string;
  username: string;
  ownerId: string;
  role: 'USER' | 'ADMIN';
  // The impersonation target, set by the guard ONLY when role === 'ADMIN' and a valid
  // X-Act-As-Owner header is present. OwnerService trusts this: a USER actor never carries it.
  actingAsOwnerId?: string;
  // Plant Doctor scoped token (Spec 3 §3.3): present ONLY on a `scope:'doctor'` token, which the global
  // DoctorScopeGuard default-denies everywhere but a five-endpoint allowlist pinned to `plantId`. An
  // ordinary owner/admin token carries neither, so it takes the normal path untouched.
  scope?: 'doctor';
  plantId?: string;
  jti: string;
  // Session-start anchor (epoch seconds) carried forward across refreshes to enforce the absolute
  // cap. Resolved from the token's `sst`, or `iat` for legacy tokens minted before the feature.
  sst: number;
  exp: number;
}

// CLS key under which the request actor is stored.
export const ACTOR_KEY = 'actor';
