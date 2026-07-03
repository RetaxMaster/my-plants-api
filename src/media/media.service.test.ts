import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { MediaService } from './media.service.js';

function makeService(row: Record<string, unknown> | null) {
  const order: string[] = [];
  const prisma = {
    mediaAsset: {
      findUnique: vi.fn(async () => row),
      delete: vi.fn(async () => {
        order.push('row-delete');
        return {};
      }),
    },
  } as unknown as ConstructorParameters<typeof MediaService>[0];
  const images = {
    upload: vi.fn(),
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
