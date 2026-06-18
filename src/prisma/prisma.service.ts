import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { DATABASE_URL } from '../config/config.module.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(DATABASE_URL) databaseUrl: string) {
    super({ datasources: { db: { url: databaseUrl } } });
  }
  async onModuleInit(): Promise<void> {
    await this.$connect();
    // Fix the session timezone to UTC so DATE/DATETIME handling is deterministic and the
    // MariaDB UTC-offset pitfall cannot shift due-date thresholds. All local-day logic is
    // done app-side via the local-date helper. (v1 runs a single connection locally; if a
    // pool is introduced later, set the server/global time_zone or a per-connection init hook
    // so every pooled connection inherits UTC.)
    await this.$executeRawUnsafe("SET time_zone = '+00:00'");
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
