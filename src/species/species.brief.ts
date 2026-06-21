import { parseSpeciesRecord } from '@retaxmaster/my-plants-species-schema';

/** The Blog brief read model: bilingual brief + species identity. */
export interface SpeciesBrief {
  slug: string;
  scientificName: string;
  commonNames: string[];
  briefEs: string | null;
  briefEn: string | null;
}

/**
 * commonNames is NOT a DB column — it lives inside the species `record` JSON.
 * We re-validate the cached JSON on read (same discipline as SpeciesService.record)
 * and return the parsed commonNames (the schema defaults it to []).
 */
export function extractCommonNames(record: unknown): string[] {
  return parseSpeciesRecord(record).commonNames;
}
