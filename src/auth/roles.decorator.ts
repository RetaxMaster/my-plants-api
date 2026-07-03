import { SetMetadata } from '@nestjs/common';

export type AppRole = 'USER' | 'ADMIN';

// Route/controller metadata key holding the roles allowed to reach a handler. Read by RolesGuard.
export const ROLES_KEY = 'roles';

// Marks a controller or handler as requiring one of the given REAL token roles. Applied together
// with `@UseGuards(RolesGuard)` (controller-scoped, so it runs after the global JwtAuthGuard).
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
