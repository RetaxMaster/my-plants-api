import * as bcrypt from 'bcrypt';
import type { PrismaClient } from '@prisma/client';

export interface CreateUserArgs {
  username: string;
  password: string;
  role: 'USER' | 'ADMIN';
  adoptDefault: boolean;
}

export function parseArgs(argv: string[]): CreateUserArgs {
  const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const username = get('--username');
  const password = get('--password');
  const roleRaw = (get('--role') ?? 'user').toLowerCase();
  const adoptDefault = argv.includes('--adopt-default');
  if (!username) throw new Error('--username is required');
  if (!password || password.length < 8) throw new Error('--password is required (min 8 chars)');
  if (roleRaw !== 'user' && roleRaw !== 'admin') throw new Error('--role must be user or admin');
  return { username, password, role: roleRaw === 'admin' ? 'ADMIN' : 'USER', adoptDefault };
}

export async function createUser(
  prisma: Pick<PrismaClient, 'user' | 'owner' | '$transaction'> | any,
  args: CreateUserArgs,
) {
  const existing = await prisma.user.findUnique({ where: { username: args.username } });
  if (existing) throw new Error(`Username already exists: ${args.username}`);
  const passwordHash = await bcrypt.hash(args.password, 12);
  return prisma.$transaction(async (tx: any) => {
    let ownerId: string;
    if (args.adoptDefault) {
      const def = await tx.owner.findFirst({ where: { name: 'default' } });
      ownerId = def ? def.id : (await tx.owner.create({ data: { name: args.username } })).id;
    } else {
      ownerId = (await tx.owner.create({ data: { name: args.username } })).id;
    }
    await tx.user.create({ data: { username: args.username, passwordHash, role: args.role, ownerId } });
    return { username: args.username, role: args.role, ownerId };
  });
}
