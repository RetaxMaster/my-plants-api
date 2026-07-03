import { IsIn, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';

// Partial update of any editable field, plus `status` and (free-form only) `slug`. `speciesSlug` is
// DELIBERATELY absent -> stripped by whitelist -> immutable via this route (you cannot re-link/unlink a
// post's species). A field sent as `null` clears it; a field omitted is left unchanged (the service
// only writes keys that are !== undefined).
export class UpdateBlogpostDto {
  @IsOptional() @IsString() @MinLength(1)
  slug?: string;

  @IsOptional() @IsIn([0, 1])
  status?: 0 | 1;

  @IsOptional() @IsString() @MinLength(1)
  titleEs?: string;

  @IsOptional() @IsString() @MinLength(1)
  titleEn?: string | null;

  @IsOptional() @IsString() @MinLength(1)
  excerptEs?: string;

  @IsOptional() @IsString() @MinLength(1)
  excerptEn?: string | null;

  @IsOptional() @IsString() @MinLength(1)
  bodyEs?: string;

  @IsOptional() @IsString() @MinLength(1)
  bodyEn?: string | null;

  @IsOptional() @IsUrl()
  coverImageUrl?: string | null;

  @IsOptional() @IsString() @MinLength(1)
  coverImageObjectKey?: string | null;

  @IsOptional() @IsUrl()
  youtubeUrl?: string | null;

  @IsOptional() @IsUrl()
  ctaLink?: string | null;

  @IsOptional() @IsString() @MinLength(1)
  ctaLabelEs?: string | null;

  @IsOptional() @IsString() @MinLength(1)
  ctaLabelEn?: string | null;
}
