import { parseSpeciesRecord, primaryCommonName } from '@retaxmaster/my-plants-species-schema';
import { readingMinutes } from './reading-time.js';

// Structural view of a blogpost row (Prisma's Blogpost satisfies this; `species` is present only when
// the query includes it). Kept structural so the mappers unit-test without importing Prisma types.
export interface BlogpostRow {
  slug: string;
  status: number;
  speciesSlug: string | null;
  titleEs: string;
  titleEn: string | null;
  excerptEs: string;
  excerptEn: string | null;
  bodyEs: string;
  bodyEn: string | null;
  coverImageUrl: string | null;
  coverImageObjectKey: string | null;
  youtubeUrl: string | null;
  ctaLink: string | null;
  ctaLabelEs: string | null;
  ctaLabelEn: string | null;
  createdByUserId: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  species?: { scientificName: string; record: unknown } | null;
}

export interface BlogpostCard {
  slug: string;
  titleEs: string;
  titleEn: string | null;
  excerptEs: string;
  excerptEn: string | null;
  coverImageUrl: string | null;
  publishedAt: Date | null;
  readingMinutes: number;
  speciesSlug: string | null;
  speciesScientificName: string | null;
  speciesCommonName: string | null;
  difficulty: string | null;
}

export interface BlogpostDetail extends BlogpostCard {
  bodyEs: string;
  bodyEn: string | null;
  youtubeUrl: string | null;
  ctaLink: string | null;
  ctaLabelEs: string | null;
  ctaLabelEn: string | null;
}

// The writing-desk list row (drafts + published).
export interface BlogpostAdminRow {
  slug: string;
  status: number;
  titleEs: string;
  excerptEs: string;
  coverImageUrl: string | null;
  speciesSlug: string | null;
  updatedAt: Date;
}

// The full editor view (any status, all fields incl. server-owned).
export interface BlogpostAdminDetail extends BlogpostRow {}

// The care-difficulty signal does NOT exist as a field in the species record contract today, so it is
// always null (the web omits the badge). Single seam to change if a difficulty field is ever added.
function difficultyFromSpecies(_species: { record: unknown } | null | undefined): string | null {
  return null;
}

function speciesNames(species: { scientificName: string; record: unknown } | null | undefined): {
  scientificName: string | null;
  commonName: string | null;
} {
  if (!species) return { scientificName: null, commonName: null };
  return {
    scientificName: species.scientificName,
    commonName: primaryCommonName(parseSpeciesRecord(species.record)),
  };
}

export function toCard(row: BlogpostRow): BlogpostCard {
  const names = speciesNames(row.species ?? null);
  return {
    slug: row.slug,
    titleEs: row.titleEs,
    titleEn: row.titleEn,
    excerptEs: row.excerptEs,
    excerptEn: row.excerptEn,
    coverImageUrl: row.coverImageUrl,
    publishedAt: row.publishedAt,
    readingMinutes: readingMinutes(row.bodyEs),
    speciesSlug: row.speciesSlug,
    speciesScientificName: names.scientificName,
    speciesCommonName: names.commonName,
    difficulty: difficultyFromSpecies(row.species ?? null),
  };
}

export function toDetail(row: BlogpostRow): BlogpostDetail {
  return {
    ...toCard(row),
    bodyEs: row.bodyEs,
    bodyEn: row.bodyEn,
    youtubeUrl: row.youtubeUrl,
    ctaLink: row.ctaLink,
    ctaLabelEs: row.ctaLabelEs,
    ctaLabelEn: row.ctaLabelEn,
  };
}

export function toAdminRow(row: BlogpostRow): BlogpostAdminRow {
  return {
    slug: row.slug,
    status: row.status,
    titleEs: row.titleEs,
    excerptEs: row.excerptEs,
    coverImageUrl: row.coverImageUrl,
    speciesSlug: row.speciesSlug,
    updatedAt: row.updatedAt,
  };
}

export function toAdminDetail(row: BlogpostRow): BlogpostAdminDetail {
  return row;
}
