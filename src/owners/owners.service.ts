import { ForbiddenException, Injectable } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface OwnerSummary {
  ownerId: string;
  username: string; // the linked user's username, or the owner's name when no user exists
  role: 'USER' | 'ADMIN' | null;
}

@Injectable()
export class OwnersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: OwnerService,
  ) {}

  // Admin-only picker source for "Acting As". NOT owner-scoped (it lists every owner); its safety is
  // the role gate on the REAL role (currentRole), which acting-as never changes.
  async list(): Promise<OwnerSummary[]> {
    if (this.owner.currentRole() !== 'ADMIN') throw new ForbiddenException('Admin only');
    // `select` (not `include`) so the user's passwordHash is never loaded into memory: non-exposure
    // is structural in the query, not dependent on the projection below never changing.
    const owners = await this.prisma.owner.findMany({
      select: { id: true, name: true, user: { select: { username: true, role: true } } },
    });
    return owners.map((o) => ({
      ownerId: o.id,
      username: o.user?.username ?? o.name,
      role: o.user?.role ?? null,
    }));
  }
}
