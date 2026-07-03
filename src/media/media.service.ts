import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ImageUploadService } from '../storage/image-upload.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { toMediaView, type MediaAssetView } from './media.read-models.js';

const PAGE_SIZE_DEFAULT = 10;
const PAGE_SIZE_MAX = 50;

function clampPageSize(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return PAGE_SIZE_DEFAULT;
  return Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(raw)));
}
function clampPage(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly images: ImageUploadService,
    private readonly owner: OwnerService,
  ) {}

  async upload(file: Express.Multer.File | undefined): Promise<MediaAssetView> {
    if (!file) throw new BadRequestException('an image file (field "image") is required');
    // One shared pipeline; size/dimensions come from the upload result (no second decode).
    const stored = await this.images.upload({ buffer: file.buffer, keyPrefix: 'blog/media' });
    // `filename` is display-only metadata stored in a VARCHAR(191); cap it so an overlong original
    // filename can never fail the insert AFTER the object is already in R2 (which would orphan it).
    const filename = (file.originalname ?? '').slice(0, 191);
    let row;
    try {
      row = await this.prisma.mediaAsset.create({
        data: {
          imageUrl: stored.imageUrl,
          imageObjectKey: stored.imageObjectKey,
          filename,
          sizeBytes: stored.sizeBytes,
          width: stored.width,
          height: stored.height,
          createdByUserId: this.owner.currentActor()?.userId ?? null,
        },
      });
    } catch (err) {
      // The DB write failed after the upload -> delete the just-uploaded object so it isn't orphaned
      // (mirrors the cover-upload compensating cleanup in BlogService.setCover).
      await this.images.delete(stored.imageObjectKey);
      throw err;
    }
    return toMediaView(row);
  }

  // Admin Scoped: newest-first list of ALL assets (no owner filter).
  async list(
    pageRaw?: number,
    pageSizeRaw?: number,
  ): Promise<{ items: MediaAssetView[]; page: number; pageSize: number; total: number; totalPages: number }> {
    const pageSize = clampPageSize(pageSizeRaw);
    const page = clampPage(pageRaw);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.mediaAsset.count(),
      this.prisma.mediaAsset.findMany({
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: rows.map(toMediaView),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async remove(id: string): Promise<{ ok: true }> {
    const row = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Unknown media asset: ${id}`);
    // Best-effort R2 cleanup FIRST (delete() swallows its own errors), then remove the row. A failed
    // object delete never blocks the row delete; the row is only removed after the delete is issued.
    await this.images.delete(row.imageObjectKey);
    await this.prisma.mediaAsset.delete({ where: { id } });
    return { ok: true };
  }
}
