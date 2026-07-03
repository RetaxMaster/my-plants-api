import { describe, expect, it } from 'vitest';
import { readingMinutes } from './reading-time.js';

describe('readingMinutes', () => {
  it('is at least 1 for a short body', () => {
    expect(readingMinutes('just a few words')).toBe(1);
    expect(readingMinutes('')).toBe(1);
  });

  it('ceils words / 200', () => {
    expect(readingMinutes(Array(200).fill('word').join(' '))).toBe(1);
    expect(readingMinutes(Array(201).fill('word').join(' '))).toBe(2);
    expect(readingMinutes(Array(450).fill('word').join(' '))).toBe(3);
  });
});
