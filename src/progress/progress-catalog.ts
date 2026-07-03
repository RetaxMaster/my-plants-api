import { BadRequestException } from '@nestjs/common';

export type ProgressTagGroup = 'positive' | 'negative';
export interface ProgressTag {
  key: string;
  label: string;
  group: ProgressTagGroup;
}

// THE single source of truth for condition tags (spec §3.1). Keys + English labels (i18n deferred).
// Exposed via GET /progress/catalog and consumed by the create-DTO validation AND the web — never
// copied. Cheap to extend: add a row here and it is instantly valid + rendered.
export const PROGRESS_TAGS: ProgressTag[] = [
  // Positive / neutral
  { key: 'NEW_LEAF', label: 'New leaf', group: 'positive' },
  { key: 'FLOWERING', label: 'Flowering', group: 'positive' },
  { key: 'SEEDLING', label: 'Seedling', group: 'positive' },
  { key: 'LARGE_LEAVES', label: 'Large leaves', group: 'positive' },
  { key: 'NEW_SHOOTS', label: 'New shoots', group: 'positive' },
  { key: 'BLOOM_COMPLETED', label: 'Bloom completed', group: 'positive' },
  // Negative
  { key: 'FALLEN_LEAF', label: 'Fallen leaf', group: 'negative' },
  { key: 'DROOPING', label: 'Drooping', group: 'negative' },
  { key: 'DRY_LEAVES', label: 'Dry leaves', group: 'negative' },
  { key: 'YELLOWING_LEAVES', label: 'Yellowing leaves', group: 'negative' },
  { key: 'NOT_GROWING', label: 'Not growing', group: 'negative' },
  { key: 'STUNTED_GROWTH', label: 'Stunted growth', group: 'negative' },
  { key: 'LEANING', label: 'Leaning', group: 'negative' },
  { key: 'PESTS', label: 'Pests', group: 'negative' },
  { key: 'FUNGUS', label: 'Fungus', group: 'negative' },
  { key: 'SPOTS', label: 'Spots', group: 'negative' },
  { key: 'DISCOLORATION', label: 'Discoloration', group: 'negative' },
];

const TAG_KEYS = new Set(PROGRESS_TAGS.map((t) => t.key));
const TAG_BY_KEY = new Map(PROGRESS_TAGS.map((t) => [t.key, t]));

// Parse the single JSON-encoded multipart `tags` field and validate every key against the catalog.
// Fixing the wire format as one JSON string field (not repeated tags[]) removes multipart array
// ambiguity. Throws BadRequestException (→ 400) on malformed JSON, a non-array, non-string elements,
// or an unknown key.
export function parseProgressTags(raw: string | undefined | null): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException('tags must be a JSON-encoded array of strings');
  }
  if (!Array.isArray(parsed) || !parsed.every((k) => typeof k === 'string')) {
    throw new BadRequestException('tags must be a JSON array of strings');
  }
  for (const key of parsed) {
    if (!TAG_KEYS.has(key)) throw new BadRequestException(`Unknown progress tag: ${key}`);
  }
  return parsed as string[];
}

// Resolve stored keys back to catalog entries (label + group) for the entry-detail response.
// Silently drops any key no longer in the catalog (e.g. a removed tag) so old entries still read.
export function resolveProgressTags(keys: string[]): ProgressTag[] {
  return keys.map((k) => TAG_BY_KEY.get(k)).filter((t): t is ProgressTag => t !== undefined);
}
