import { Injectable, NotFoundException } from '@nestjs/common';
import { parseSpeciesRecord, primaryCommonName, type SpeciesRecord } from '@retaxmaster/my-plants-species-schema';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class SpeciesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<
    { slug: string; scientificName: string; commonNameEs: string | null; commonNameEn: string | null }[]
  > {
    const rows = await this.prisma.species.findMany({ select: { slug: true, scientificName: true, record: true } });
    return rows.map((r) => {
      const record = parseSpeciesRecord(r.record);
      return {
        slug: r.slug,
        scientificName: r.scientificName,
        commonNameEs: primaryCommonName(record, 'es'),
        commonNameEn: primaryCommonName(record, 'en'),
      };
    });
  }

  async record(slug: string): Promise<SpeciesRecord> {
    const row = await this.prisma.species.findUnique({ where: { slug } });
    if (!row) throw new NotFoundException(`Unknown species: ${slug}`);
    return parseSpeciesRecord(row.record); // re-validate the cached JSON on read
  }
}
