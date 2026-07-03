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
