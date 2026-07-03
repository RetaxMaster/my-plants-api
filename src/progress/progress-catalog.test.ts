import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PROGRESS_TAGS, parseProgressTags, resolveProgressTags } from './progress-catalog.js';

describe('PROGRESS_TAGS catalog', () => {
  it('has stable keys grouped positive/negative', () => {
    expect(PROGRESS_TAGS.find((t) => t.key === 'NEW_LEAF')?.group).toBe('positive');
    expect(PROGRESS_TAGS.find((t) => t.key === 'PESTS')?.group).toBe('negative');
    // keys are unique
    expect(new Set(PROGRESS_TAGS.map((t) => t.key)).size).toBe(PROGRESS_TAGS.length);
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
  it('maps stored keys to catalog {key,label,group}, dropping unknowns', () => {
    const resolved = resolveProgressTags(['PESTS', 'GHOST']);
    expect(resolved).toEqual([{ key: 'PESTS', label: 'Pests', group: 'negative' }]);
  });
});
