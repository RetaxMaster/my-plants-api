import { BadRequestException } from '@nestjs/common';
import {
  PROGRESS_TAG_KEYS,
  PROGRESS_TAG_GROUPS,
  type ProgressTagGroup,
} from '@retaxmaster/my-plants-species-schema/progress-tag-constants';

export type { ProgressTagGroup };
// The wire contract is KEY-BASED (spec §1.2): the English label is GONE. The label is the web's i18n concern,
// resolved from `key`; the catalog and the stored-tag round-trip carry only `{ key, group }`.
export interface ProgressTag {
  key: string;
  group: ProgressTagGroup;
}

// THE single source of the tag vocabulary now lives in the shared package (spec §1.3). Build the catalog
// from it so the API and the web can never disagree about which keys exist or their group. Add a tag by
// editing the shared PROGRESS_TAG_KEYS + PROGRESS_TAG_GROUPS — never here.
export const PROGRESS_TAGS: ProgressTag[] = PROGRESS_TAG_KEYS.map((key) => ({
  key,
  group: PROGRESS_TAG_GROUPS[key],
}));

const TAG_KEYS = new Set<string>(PROGRESS_TAG_KEYS);
const TAG_BY_KEY = new Map<string, ProgressTag>(PROGRESS_TAGS.map((t) => [t.key, t]));

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

// Resolve stored keys back to catalog entries ({ key, group }) for the entry-detail response.
// Silently drops any key no longer in the catalog (e.g. a removed tag) so old entries still read.
export function resolveProgressTags(keys: string[]): ProgressTag[] {
  return keys.map((k) => TAG_BY_KEY.get(k)).filter((t): t is ProgressTag => t !== undefined);
}
