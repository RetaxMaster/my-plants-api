import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateBlogpostDto } from './create-blogpost.dto.js';
import { UpdateBlogpostDto } from './update-blogpost.dto.js';

const validCreate = { titleEs: 'T', excerptEs: 'E', bodyEs: 'B' };

function errorsFor<T extends object>(cls: new () => T, payload: object): string[] {
  const dto = plainToInstance(cls, payload);
  return validateSync(dto, { whitelist: true }).flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe('CreateBlogpostDto.coverImagePrompt', () => {
  it('is valid when omitted (optional)', () => {
    expect(errorsFor(CreateBlogpostDto, validCreate)).toHaveLength(0);
  });
  it('is valid with a non-empty string', () => {
    expect(errorsFor(CreateBlogpostDto, { ...validCreate, coverImagePrompt: 'a cover prompt' })).toHaveLength(0);
  });
  it('is valid with an explicit null (IsOptional allows null)', () => {
    expect(errorsFor(CreateBlogpostDto, { ...validCreate, coverImagePrompt: null })).toHaveLength(0);
  });
  it('is rejected when an empty string (MinLength mirrors the contract)', () => {
    expect(errorsFor(CreateBlogpostDto, { ...validCreate, coverImagePrompt: '' })).toContain('minLength');
  });
});

describe('UpdateBlogpostDto.coverImagePrompt', () => {
  it('accepts a non-empty string and rejects an empty one', () => {
    expect(errorsFor(UpdateBlogpostDto, { coverImagePrompt: 'x' })).toHaveLength(0);
    expect(errorsFor(UpdateBlogpostDto, { coverImagePrompt: '' })).toContain('minLength');
  });
  it('accepts an explicit null (a null clears the field via the service)', () => {
    expect(errorsFor(UpdateBlogpostDto, { coverImagePrompt: null })).toHaveLength(0);
  });
});
