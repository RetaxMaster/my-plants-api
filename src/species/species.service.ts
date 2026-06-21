import { Injectable, NotFoundException } from '@nestjs/common';
import { parseSpeciesRecord, type SpeciesRecord } from '@retaxmaster/my-plants-species-schema';
import { PrismaService } from '../prisma/prisma.service.js';
import { extractCommonNames, type SpeciesBrief } from './species.brief.js';

@Injectable()
export class SpeciesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<{ slug: string; scientificName: string }[]> {
    return this.prisma.species.findMany({ select: { slug: true, scientificName: true } });
  }

  async record(slug: string): Promise<SpeciesRecord> {
    const row = await this.prisma.species.findUnique({ where: { slug } });
    if (!row) throw new NotFoundException(`Unknown species: ${slug}`);
    return parseSpeciesRecord(row.record); // re-validate the cached JSON on read
  }

  async brief(slug: string): Promise<SpeciesBrief> {
    const row = await this.prisma.species.findUnique({ where: { slug } });
    if (!row) throw new NotFoundException(`Unknown species: ${slug}`);
    return {
      slug: row.slug,
      scientificName: row.scientificName,
      commonNames: extractCommonNames(row.record), // not a column; lives in record JSON
      briefEs: row.briefEs,
      briefEn: row.briefEn,
    };
  }
}
