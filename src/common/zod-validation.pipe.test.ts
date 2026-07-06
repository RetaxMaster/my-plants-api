import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { plantProfileUpdateSchema } from '@retaxmaster/my-plants-species-schema';
import { ZodValidationPipe } from './zod-validation.pipe.js';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(plantProfileUpdateSchema);

  it('passes a valid partial body through, returning the parsed data', () => {
    expect(pipe.transform({ potType: 'terracotta', potSizeCm: 14 })).toEqual({
      potType: 'terracotta',
      potSizeCm: 14,
    });
  });

  it('accepts an explicit null (clear) and an empty object (no-op)', () => {
    expect(pipe.transform({ soilMix: null })).toEqual({ soilMix: null });
    expect(pipe.transform({})).toEqual({});
  });

  it('throws BadRequestException on an out-of-vocabulary enum', () => {
    expect(() => pipe.transform({ potType: 'wood' })).toThrow(BadRequestException);
  });

  it('throws BadRequestException on a non-positive potSizeCm', () => {
    expect(() => pipe.transform({ potSizeCm: 0 })).toThrow(BadRequestException);
  });
});
