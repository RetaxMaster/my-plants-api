import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PROGRESS_TAG_KEYS } from '@retaxmaster/my-plants-species-schema/progress-tag-constants';
import { PROGRESS_TAGS, parseProgressTags, resolveProgressTags } from './progress-catalog.js';

describe('PROGRESS_TAGS catalog', () => {
  it('has stable keys grouped positive/negative', () => {
    expect(PROGRESS_TAGS.find((t) => t.key === 'NEW_LEAF')?.group).toBe('positive');
    expect(PROGRESS_TAGS.find((t) => t.key === 'PESTS')?.group).toBe('negative');
    // keys are unique
    expect(new Set(PROGRESS_TAGS.map((t) => t.key)).size).toBe(PROGRESS_TAGS.length);
  });

  it('exposes exactly { key, group } per tag — no English label on the wire (spec §1.2)', () => {
    for (const tag of PROGRESS_TAGS) {
      expect(Object.keys(tag).sort()).toEqual(['group', 'key']);
      expect(tag).not.toHaveProperty('label');
    }
  });

  it('is built from the SHARED PROGRESS_TAG_KEYS (single source; same order)', () => {
    expect(PROGRESS_TAGS.map((t) => t.key)).toEqual([...PROGRESS_TAG_KEYS]);
  });
});

describe('parseProgressTags', () => {
  it('returns [] for undefined/empty', () => {
    expect(parseProgressTags(undefined)).toEqual([]);
    expect(parseProgressTags('')).toEqual([]);
  });

  it('parses a JSON array of known keys', () => {
    expect(parseProgressTags('["YELLOWING_LEAVES","PESTS"]')).toEqual(['YELLOWING_LEAVES', 'PESTS']);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseProgressTags('not json')).toThrow(BadRequestException);
  });

  it('rejects a non-array / non-string-elements payload', () => {
    expect(() => parseProgressTags('{"a":1}')).toThrow(BadRequestException);
    expect(() => parseProgressTags('[1,2]')).toThrow(BadRequestException);
  });

  it('rejects an unknown tag key', () => {
    expect(() => parseProgressTags('["MADE_UP_KEY"]')).toThrow(BadRequestException);
  });
});

describe('resolveProgressTags', () => {
  it('maps stored keys to { key, group }, dropping unknowns', () => {
    const resolved = resolveProgressTags(['NEW_LEAF', 'PESTS', 'GONE_KEY']);
    expect(resolved).toEqual([
      { key: 'NEW_LEAF', group: 'positive' },
      { key: 'PESTS', group: 'negative' },
    ]);
  });
});
