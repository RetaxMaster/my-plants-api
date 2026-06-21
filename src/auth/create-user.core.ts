import * as bcrypt from 'bcrypt';
import type { PrismaClient } from '@prisma/client';

export interface CreateUserArgs {
  username: string;
  password: string;
  role: 'USER' | 'ADMIN';
}

export function parseArgs(argv: string[]): CreateUserArgs {
  const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const username = get('--username');
  const password = get('--password');
  const roleRaw = (get('--role') ?? 'user').toLowerCase();
  if (!username) throw new Error('--username is required');
  if (!password || password.length < 8) throw new Error('--password is required (min 8 chars)');
  if (roleRaw !== 'user' && roleRaw !== 'admin') throw new Error('--role must be user or admin');
  return { username, password, role: roleRaw === 'admin' ? 'ADMIN' : 'USER' };
}

export async function createUser(
  prisma: Pick<PrismaClient, 'user' | 'owner' | '$transaction'> | any,
  args: CreateUserArgs,
) {
  const existing = await prisma.user.findUnique({ where: { username: args.username } });
  if (existing) throw new Error(`Username already exists: ${args.username}`);
  const passwordHash = await bcrypt.hash(args.password, 12);
  return prisma.$transaction(async (tx: any) => {
    // Every new user gets a fresh, empty owner (garden) of their own.
    const ownerId = (await tx.owner.create({ data: { name: args.username } })).id;
    await tx.user.create({ data: { username: args.username, passwordHash, role: args.role, ownerId } });
    return { username: args.username, role: args.role, ownerId };
  });
}
