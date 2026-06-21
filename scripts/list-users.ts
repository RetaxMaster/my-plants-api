import '../src/config/load-env-file.js';
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({ select: { username: true, role: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
    for (const u of users) console.log(`${u.username}\t${u.role}\t${u.createdAt.toISOString()}`);
    if (users.length === 0) console.log('(no users yet)');
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
