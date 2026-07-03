import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { BlogService } from './blog.service.js';

function makeService(overrides: Record<string, unknown> = {}) {
  const store = new Map<string, Record<string, unknown>>();
  const prisma = {
    blogpost: {
      findUnique: vi.fn(async ({ where }: { where: { slug: string } }) =>
        store.get(where.slug) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        store.set(data.slug as string, data);
        return data;
      }),
      delete: vi.fn(async ({ where }: { where: { slug: string } }) => {
        store.delete(where.slug);
        return {};
      }),
      ...(overrides.blogpost ?? {}),
    },
  } as unknown as ConstructorParameters<typeof BlogService>[0];
  const owner = { currentActor: () => ({ userId: 'admin-1' }) } as unknown as ConstructorParameters<
    typeof BlogService
  >[1];
  return { service: new BlogService(prisma, owner), store, prisma };
}

const base = {
  titleEs: 'Cómo cuidar tu Pothos',
  excerptEs: 'Guía breve',
  bodyEs: '# Pothos\ncontenido',
};

describe('BlogService.create', () => {
  it('derives the slug from titleEs, defaults to DRAFT with null publishedAt, stamps createdByUserId', async () => {
    const { service } = makeService();
    const post = await service.create({ ...base }, 'admin-1');
    expect(post.slug).toBe('como-cuidar-tu-pothos');
    expect(post.status).toBe(0);
    expect(post.publishedAt).toBeNull();
    expect(post.speciesSlug).toBeNull();
    expect(post.createdByUserId).toBe('admin-1');
  });

  it('sets publishedAt when created directly as PUBLISHED', async () => {
    const { service } = makeService();
    const post = await service.create({ ...base, status: 1 }, 'admin-1');
    expect(post.status).toBe(1);
    expect(post.publishedAt).toBeInstanceOf(Date);
  });

  it('suffixes the slug on collision', async () => {
    const { service } = makeService();
    await service.create({ ...base }, 'admin-1');
    const second = await service.create({ ...base }, 'admin-1');
    expect(second.slug).toBe('como-cuidar-tu-pothos-2');
  });
});

describe('BlogService.remove', () => {
  it('rejects deleting a species-linked post with a typed 409', async () => {
    const { service, store } = makeService();
    store.set('monstera-deliciosa', { slug: 'monstera-deliciosa', speciesSlug: 'monstera-deliciosa' });
    await expect(service.remove('monstera-deliciosa')).rejects.toBeInstanceOf(ConflictException);
  });

  it('deletes a free-form post', async () => {
    const { service, store } = makeService();
    store.set('free-1', { slug: 'free-1', speciesSlug: null });
    await expect(service.remove('free-1')).resolves.toEqual({ ok: true });
    expect(store.has('free-1')).toBe(false);
  });
});
