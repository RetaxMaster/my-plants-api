import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BlogpostStatus, toBlogpostSlug } from '@retaxmaster/my-plants-species-schema';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { ImageUploadService } from '../storage/image-upload.service.js';
import {
  toAdminDetail,
  toAdminRow,
  toCard,
  toDetail,
  type BlogpostAdminDetail,
  type BlogpostAdminRow,
  type BlogpostCard,
  type BlogpostDetail,
} from './blog.read-models.js';
import type { CreateBlogpostDto } from './dto/create-blogpost.dto.js';
import type { UpdateBlogpostDto } from './dto/update-blogpost.dto.js';

const PAGE_SIZE_DEFAULT = 10;
const PAGE_SIZE_MAX = 50;
const speciesInclude = { species: { select: { scientificName: true, record: true } } } as const;

function clampPageSize(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return PAGE_SIZE_DEFAULT;
  return Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(raw)));
}
function clampPage(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

@Injectable()
export class BlogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: OwnerService,
    private readonly images: ImageUploadService,
  ) {}

  // ---- Public (published only) ----
  async feed(
    pageRaw?: number,
    pageSizeRaw?: number,
  ): Promise<{ items: BlogpostCard[]; page: number; pageSize: number; total: number; totalPages: number }> {
    const pageSize = clampPageSize(pageSizeRaw);
    const page = clampPage(pageRaw);
    const where = { status: BlogpostStatus.PUBLISHED };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.blogpost.count({ where }),
      this.prisma.blogpost.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: speciesInclude,
      }),
    ]);
    return {
      items: rows.map(toCard),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async bySlug(slug: string): Promise<BlogpostDetail> {
    const post = await this.prisma.blogpost.findUnique({ where: { slug }, include: speciesInclude });
    if (!post || post.status !== BlogpostStatus.PUBLISHED) {
      throw new NotFoundException(`Unknown blogpost: ${slug}`);
    }
    return toDetail(post);
  }

  // ---- Admin Scoped (no ownerFilter) ----
  async adminList(params: {
    status?: number;
    page?: number;
    pageSize?: number;
    q?: string;
  }): Promise<{ items: BlogpostAdminRow[]; page: number; pageSize: number; total: number; totalPages: number }> {
    const pageSize = clampPageSize(params.pageSize);
    const page = clampPage(params.page);
    const where: Record<string, unknown> = {};
    if (params.status !== undefined && Number.isFinite(params.status)) where.status = params.status;
    if (params.q && params.q.trim()) {
      const q = params.q.trim();
      where.OR = [{ slug: { contains: q } }, { titleEs: { contains: q } }, { titleEn: { contains: q } }];
    }
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.blogpost.count({ where }),
      this.prisma.blogpost.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: rows.map(toAdminRow),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async create(dto: CreateBlogpostDto, actorUserId: string | null): Promise<BlogpostAdminDetail> {
    const status = dto.status ?? BlogpostStatus.DRAFT;
    const baseSlug = dto.slug && dto.slug.length ? dto.slug : toBlogpostSlug(dto.titleEs);
    const slug = await this.resolveFreeSlug(baseSlug);
    // Direct-publish create must stamp publishedAt (the public feed orders by publishedAt DESC; a null
    // would sort wrong and break the invariant). Omitting status yields DRAFT with publishedAt null.
    const publishedAt = status === BlogpostStatus.PUBLISHED ? new Date() : null;
    const post = await this.prisma.blogpost.create({
      data: {
        slug,
        status,
        speciesSlug: null, // desk creates free-form posts only
        titleEs: dto.titleEs,
        titleEn: dto.titleEn ?? null,
        excerptEs: dto.excerptEs,
        excerptEn: dto.excerptEn ?? null,
        bodyEs: dto.bodyEs,
        bodyEn: dto.bodyEn ?? null,
        coverImageUrl: dto.coverImageUrl ?? null,
        coverImageObjectKey: dto.coverImageObjectKey ?? null,
        youtubeUrl: dto.youtubeUrl ?? null,
        ctaLink: dto.ctaLink ?? null,
        ctaLabelEs: dto.ctaLabelEs ?? null,
        ctaLabelEn: dto.ctaLabelEn ?? null,
        createdByUserId: actorUserId,
        publishedAt,
      },
    });
    return toAdminDetail(post);
  }

  async adminGet(slug: string): Promise<BlogpostAdminDetail> {
    const post = await this.prisma.blogpost.findUnique({ where: { slug } });
    if (!post) throw new NotFoundException(`Unknown blogpost: ${slug}`);
    return toAdminDetail(post);
  }

  async update(slug: string, dto: UpdateBlogpostDto): Promise<BlogpostAdminDetail> {
    const existing = await this.prisma.blogpost.findUnique({ where: { slug } });
    if (!existing) throw new NotFoundException(`Unknown blogpost: ${slug}`);

    const data: Record<string, unknown> = {};
    const editable = [
      'titleEs', 'titleEn', 'excerptEs', 'excerptEn', 'bodyEs', 'bodyEn',
      'coverImageUrl', 'coverImageObjectKey', 'youtubeUrl', 'ctaLink', 'ctaLabelEs', 'ctaLabelEn',
    ] as const;
    for (const field of editable) {
      if (dto[field] !== undefined) data[field] = dto[field];
    }

    if (dto.status !== undefined) {
      data.status = dto.status;
      // On a 0 -> 1 (publish) transition, set publishedAt if not already set.
      if (dto.status === BlogpostStatus.PUBLISHED && !existing.publishedAt) data.publishedAt = new Date();
    }

    if (dto.slug !== undefined && dto.slug !== slug) {
      // Renaming the slug is allowed for FREE-FORM posts only (keeps slug === speciesSlug for guides).
      if (existing.speciesSlug !== null) {
        throw new BadRequestException({
          code: 'blogpost_slug_immutable_species_linked',
          message: 'A species-linked blogpost slug cannot be renamed.',
        });
      }
      const taken = await this.prisma.blogpost.findUnique({ where: { slug: dto.slug }, select: { slug: true } });
      if (taken) {
        throw new ConflictException({ code: 'blogpost_slug_taken', message: `Slug already in use: ${dto.slug}` });
      }
      data.slug = dto.slug;
    }

    const post = await this.prisma.blogpost.update({ where: { slug }, data });
    return toAdminDetail(post);
  }

  async remove(slug: string): Promise<{ ok: true }> {
    const existing = await this.prisma.blogpost.findUnique({ where: { slug } });
    if (!existing) throw new NotFoundException(`Unknown blogpost: ${slug}`);
    // Enforces "a species needs its blogpost": Claude's species guides are editable but not deletable.
    if (existing.speciesSlug !== null) {
      throw new ConflictException({
        code: 'blogpost_species_linked_undeletable',
        message: 'A species-linked blogpost cannot be deleted (it would orphan the species).',
      });
    }
    await this.prisma.blogpost.delete({ where: { slug } });
    await this.images.delete(existing.coverImageObjectKey); // best-effort: never blocks the delete
    return { ok: true };
  }

  async setCover(slug: string, file: Express.Multer.File | undefined): Promise<BlogpostAdminDetail> {
    if (!file) throw new BadRequestException('a cover file (field "cover") is required');
    const existing = await this.prisma.blogpost.findUnique({ where: { slug } });
    if (!existing) throw new NotFoundException(`Unknown blogpost: ${slug}`);

    const stored = await this.images.upload({ buffer: file.buffer, keyPrefix: 'blog/covers' });
    let post;
    try {
      post = await this.prisma.blogpost.update({
        where: { slug },
        data: { coverImageUrl: stored.imageUrl, coverImageObjectKey: stored.imageObjectKey },
      });
    } catch (err) {
      // The DB write failed after the upload -> delete the just-uploaded object so it isn't orphaned.
      await this.images.delete(stored.imageObjectKey);
      throw err;
    }
    // Replace succeeded: best-effort delete of the PREVIOUS cover object (never blocks the response).
    await this.images.delete(existing.coverImageObjectKey);
    return toAdminDetail(post);
  }

  private async resolveFreeSlug(base: string): Promise<string> {
    let candidate = base;
    let n = 1;
    // The @id uniqueness is the source of truth; we resolve collisions at the service layer.
    while (await this.prisma.blogpost.findUnique({ where: { slug: candidate }, select: { slug: true } })) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    return candidate;
  }
}
