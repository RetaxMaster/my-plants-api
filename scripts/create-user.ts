import '../src/config/load-env-file.js';
import { PrismaClient } from '@prisma/client';
import { parseArgs, createUser } from '../src/auth/create-user.core.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const r = await createUser(prisma, args);
    console.log(`Created user '${r.username}' (role ${r.role}) → owner ${r.ownerId}`);
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
