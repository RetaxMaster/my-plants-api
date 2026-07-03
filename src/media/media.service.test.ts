import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { MediaService } from './media.service.js';

function makeService(
  row: Record<string, unknown> | null,
  opts: { createImpl?: () => Promise<unknown> } = {},
) {
  const order: string[] = [];
  const prisma = {
    mediaAsset: {
      findUnique: vi.fn(async () => row),
      create: vi.fn(opts.createImpl ?? (async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'm-new',
        createdAt: new Date(),
        width: null,
        height: null,
        ...data,
      }))),
      delete: vi.fn(async () => {
        order.push('row-delete');
        return {};
      }),
    },
  } as unknown as ConstructorParameters<typeof MediaService>[0];
  const images = {
    upload: vi.fn(async () => ({
      imageUrl: 'https://cdn.test/x.webp',
      imageObjectKey: 'blog/media/x.webp',
      sizeBytes: 10,
      width: 4,
      height: 4,
    })),
    delete: vi.fn(async () => {
      order.push('object-delete');
    }),
  } as unknown as ConstructorParameters<typeof MediaService>[1];
  const owner = { currentActor: () => ({ userId: 'admin-1' }) } as unknown as ConstructorParameters<
    typeof MediaService
  >[2];
  return { service: new MediaService(prisma, images, owner), order, images };
}

describe('MediaService.remove', () => {
  it('deletes the R2 object BEFORE removing the row (best-effort object cleanup)', async () => {
    const { service, order } = makeService({ id: 'm1', imageObjectKey: 'blog/media/x.webp' });
    await expect(service.remove('m1')).resolves.toEqual({ ok: true });
    expect(order).toEqual(['object-delete', 'row-delete']);
  });

  it('404s when the asset does not exist', async () => {
    const { service } = makeService(null);
    await expect(service.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MediaService.upload', () => {
  it('deletes the just-uploaded R2 object when the DB insert fails (no orphan)', async () => {
    const boom = new Error('db write failed');
    const { service, order, images } = makeService(null, {
      createImpl: async () => {
        throw boom;
      },
    });
    const file = { buffer: Buffer.from('x'), originalname: 'photo.jpg' } as Express.Multer.File;
    await expect(service.upload(file)).rejects.toBe(boom);
    // The uploaded object was cleaned up after the failed insert.
    expect(order).toEqual(['object-delete']);
    expect(images.delete).toHaveBeenCalledWith('blog/media/x.webp');
  });

  it('caps an overlong filename to 191 chars before insert', async () => {
    let stored: Record<string, unknown> | undefined;
    const { service } = makeService(null, {
      createImpl: async ({ data }: { data: Record<string, unknown> }) => {
        stored = data;
        return { id: 'm1', createdAt: new Date(), width: 4, height: 4, ...data };
      },
    });
    const long = `${'a'.repeat(300)}.jpg`;
    const file = { buffer: Buffer.from('x'), originalname: long } as Express.Multer.File;
    await service.upload(file);
    expect((stored!.filename as string).length).toBe(191);
  });
});
