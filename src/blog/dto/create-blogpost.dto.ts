import { IsIn, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';

// Admin writing-desk create. `speciesSlug` is DELIBERATELY absent: species-linked posts are created by
// the knowledge-engine, not the desk, so the desk only creates free-form posts. With the global
// ValidationPipe `whitelist: true`, any `speciesSlug` a client sends is stripped -> it can never be set
// here (spec §7.2: "speciesSlug MUST be null on this admin route"). Field set/nullability mirror
// blogpostInputSchema minus server-owned fields.
export class CreateBlogpostDto {
  @IsOptional() @IsString() @MinLength(1)
  slug?: string;

  @IsOptional() @IsIn([0, 1])
  status?: 0 | 1;

  @IsString() @MinLength(1)
  titleEs!: string;

  @IsOptional() @IsString() @MinLength(1)
  titleEn?: string | null;

  @IsString() @MinLength(1)
  excerptEs!: string;

  @IsOptional() @IsString() @MinLength(1)
  excerptEn?: string | null;

  @IsString() @MinLength(1)
  bodyEs!: string;

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
