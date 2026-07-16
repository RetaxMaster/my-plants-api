import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsPositive, IsString, Matches, MaxLength } from 'class-validator';
import { ProgressHealth } from '@prisma/client';

export class CreateProgressDto {
  // Required (Planta's mandatory "¿Está sana tu planta?").
  @IsEnum(ProgressHealth) health!: ProgressHealth;

  // Optional journal date (backdatable). Multipart string; validate the shape here, convert to a
  // native UTC Date in the service. Defaults to "today" in the plant's place-city timezone.
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'occurredOn must be YYYY-MM-DD' }) occurredOn?: string;

  @IsOptional() @IsString() @MaxLength(2000) observations?: string;

  // Coerced from the multipart string; must be a positive integer (cm).
  @IsOptional() @Type(() => Number) @IsInt() @IsPositive() sizeCm?: number;

  // A SINGLE JSON-encoded field, e.g. tags='["YELLOWING_LEAVES","PESTS"]'. Parsed + validated against
  // the catalog in the service (parseProgressTags) — one authoritative catalog, no second list.
  @IsOptional() @IsString() tags?: string;
}

// Edit DTO (spec §2.5). Every field is OPTIONAL and the clear-vs-absent distinction is load-bearing:
//   - ABSENT (the key never arrived on the multipart body)  → leave the column unchanged.
//   - PRESENT-BUT-EMPTY ('', '[]')                           → clear the column (to null / empty).
// class-transformer turns every multipart value into a string and only sets a key when the field is
// actually present, so `dto.field !== undefined` is a reliable presence check (the documented sentinel).
// `health` and `occurredOn` cannot be cleared — they are required on the entry; validation below only
// constrains their SHAPE, and the service ignores them when absent.
export class UpdateProgressDto {
  @IsOptional() @IsEnum(ProgressHealth) health?: ProgressHealth;

  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'occurredOn must be YYYY-MM-DD' }) occurredOn?: string;

  // Present-but-empty ('') clears observations. MaxLength still applies to a non-empty value.
  @IsOptional() @IsString() @MaxLength(2000) observations?: string;

  // sizeCm is a STRING here (not @Type(Number)) precisely so present-empty '' can mean CLEAR — a coerced
  // number cannot represent "" distinctly. The service parses it: '' → null; a positive-integer string →
  // that int; anything else → 400. Documented divergence from CreateProgressDto's numeric coercion.
  @IsOptional() @IsString() @Matches(/^(\d+)?$/, { message: 'sizeCm must be a non-negative integer or empty' }) sizeCm?: string;

  // The SINGLE JSON-encoded tags array, same shape as create. '' or '[]' clears; else parsed + validated
  // against the ONE catalog by parseProgressTags in the service (no second list).
  @IsOptional() @IsString() tags?: string;

  // JSON-encoded string array of photo ids to remove (spec §2.1). '' / absent → remove nothing. Parsed +
  // validated (must be a string[]) in the service.
  @IsOptional() @IsString() removePhotoIds?: string;
}
