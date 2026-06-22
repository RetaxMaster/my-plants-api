import { IsBoolean, IsString, MinLength, ValidateIf } from 'class-validator';

// ValidateIf (value !== undefined) instead of @IsOptional(): an absent field is skipped, but an
// explicit `null` is still validated and rejected (400). These fields are optional, not nullable.
export class UpdatePlaceDto {
  @ValidateIf((_, v) => v !== undefined) @IsString() @MinLength(1) name?: string;
  @ValidateIf((_, v) => v !== undefined) @IsBoolean() climateControlled?: boolean;
}
