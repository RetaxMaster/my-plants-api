// Server-computed reading estimate from the leading-language (ES) body: max(1, ceil(words / 200)).
// One implementation, imported by the feed + detail mappers (no fork).
const WORDS_PER_MINUTE = 200;

export function readingMinutes(body: string): number {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}
