import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

const DEFAULT_OWNER_NAME = 'default';

@Injectable()
export class OwnerService {
  constructor(private readonly prisma: PrismaService) {}

  // v1: one owner. The whole app calls this; multi-user later replaces only this method.
  async currentOwnerId(): Promise<string> {
    const existing = await this.prisma.owner.findFirst({ where: { name: DEFAULT_OWNER_NAME } });
    if (existing) return existing.id;
    const created = await this.prisma.owner.create({ data: { name: DEFAULT_OWNER_NAME } });
    return created.id;
  }
}
