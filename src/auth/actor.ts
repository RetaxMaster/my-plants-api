// The authenticated actor for the current request, written into CLS by the JwtAuthGuard and read
// by OwnerService. `username` travels in the JWT payload (Phase 2) and rides along here so request
// handlers (e.g. GET /auth/me) can echo it without another DB read.
export interface Actor {
  userId: string;
  username: string;
  ownerId: string;
  role: 'USER' | 'ADMIN';
  jti: string;
  exp: number;
}

// CLS key under which the request actor is stored.
export const ACTOR_KEY = 'actor';
