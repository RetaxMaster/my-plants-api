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
      update: vi.fn(async ({ where, data }: { where: { slug: string }; data: Record<string, unknown> }) => {
        const cur = store.get(where.slug) ?? {};
        const next = { ...cur, ...data };
        store.set(where.slug, next);
        return next;
      }),
      ...(overrides.blogpost ?? {}),
    },
  } as unknown as ConstructorParameters<typeof BlogService>[0];
  const owner = { currentActor: () => ({ userId: 'admin-1' }) } as unknown as ConstructorParameters<
    typeof BlogService
  >[1];
  const images = {
    upload: vi.fn(async () => ({
      imageUrl: 'https://cdn.test/cover.webp',
      imageObjectKey: 'blog/covers/cover.webp',
      sizeBytes: 123,
      width: 800,
      height: 600,
    })),
    delete: vi.fn(async () => {}),
  } as unknown as ConstructorParameters<typeof BlogService>[2];
  return { service: new BlogService(prisma, owner, images), store, prisma };
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

describe('BlogService.create — coverImagePrompt', () => {
  it('writes coverImagePrompt when provided', async () => {
    const { service } = makeService();
    const post = await service.create({ ...base, coverImagePrompt: 'a cover prompt' }, 'admin-1');
    expect(post.coverImagePrompt).toBe('a cover prompt');
  });

  it('defaults coverImagePrompt to null when omitted', async () => {
    const { service } = makeService();
    const post = await service.create({ ...base }, 'admin-1');
    expect(post.coverImagePrompt).toBeNull();
  });
});

describe('BlogService.update — coverImagePrompt', () => {
  it('updates coverImagePrompt when defined and clears it when null', async () => {
    const { service, store } = makeService();
    store.set('free-1', { slug: 'free-1', speciesSlug: null, coverImagePrompt: 'old', publishedAt: null });
    const updated = await service.update('free-1', { coverImagePrompt: 'new' });
    expect(updated.coverImagePrompt).toBe('new');
    const cleared = await service.update('free-1', { coverImagePrompt: null });
    expect(cleared.coverImagePrompt).toBeNull();
  });

  it('leaves coverImagePrompt unchanged when the key is omitted (write-when-defined)', async () => {
    const { service, store } = makeService();
    store.set('free-1', { slug: 'free-1', speciesSlug: null, coverImagePrompt: 'keep', publishedAt: null });
    const updated = await service.update('free-1', { titleEs: 'renamed' });
    expect(updated.coverImagePrompt).toBe('keep');
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
