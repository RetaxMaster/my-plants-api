import { IsString, MinLength, ValidateIf } from 'class-validator';

// ValidateIf (value !== undefined) instead of @IsOptional(): an ABSENT field is skipped, but an
// explicit `null` is still validated and therefore rejected (400) — `@IsOptional()` would let
// `null` through to the service and crash on `.trim()`. These fields are optional, not nullable.
export class UpdatePlantDto {
  @ValidateIf((_, v) => v !== undefined) @IsString() nickname?: string; // "" / whitespace → cleared to null
  @ValidateIf((_, v) => v !== undefined) @IsString() @MinLength(1) placeId?: string;
}
