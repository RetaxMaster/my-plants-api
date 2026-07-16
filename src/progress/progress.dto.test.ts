import 'reflect-metadata'; // class-validator/transformer decorators read metadata at runtime (main.ts does this in prod)
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateProgressDto, MAX_SIZE_CM } from './progress.dto.js';

// The global ValidationPipe (whitelist + transform) validates CreateProgressDto before the service sees it,
// so sizeCm's bounds are a DTO-layer concern. This pins create↔edit parity: an INT-overflowing sizeCm is
// rejected on POST too (edit's parseSizeCm already rejects it), never reaching a raw MariaDB out-of-range 500.
function errorsFor(raw: Record<string, unknown>) {
  const dto = plainToInstance(CreateProgressDto, raw, { enableImplicitConversion: false });
  return validateSync(dto).flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe('CreateProgressDto.sizeCm bounds (code-review round 2 — create↔edit parity)', () => {
  it('accepts a positive integer within the INT range', () => {
    expect(errorsFor({ health: 'GOOD', sizeCm: 45 })).toHaveLength(0);
    expect(errorsFor({ health: 'GOOD', sizeCm: MAX_SIZE_CM })).toHaveLength(0);
  });

  it('rejects an INT-overflowing sizeCm via @Max', () => {
    expect(errorsFor({ health: 'GOOD', sizeCm: MAX_SIZE_CM + 1 })).toContain('max');
    expect(errorsFor({ health: 'GOOD', sizeCm: 9_999_999_999 })).toContain('max');
  });

  it('rejects a non-positive sizeCm via @IsPositive', () => {
    expect(errorsFor({ health: 'GOOD', sizeCm: 0 })).toContain('isPositive');
    expect(errorsFor({ health: 'GOOD', sizeCm: -5 })).toContain('isPositive');
  });
});
