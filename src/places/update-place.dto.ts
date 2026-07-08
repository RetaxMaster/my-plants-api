import { IsBoolean, IsEnum, IsIn, IsString, MinLength, ValidateIf } from 'class-validator';
import { HumidityCharacter, LightType } from '@prisma/client';
import { AIRFLOW, type Airflow } from '@retaxmaster/my-plants-species-schema';

// ValidateIf (value !== undefined) instead of @IsOptional(): an absent field is skipped, but an explicit
// value is validated. name/climateControlled/lightType are optional-not-nullable (an explicit null is
// rejected — lightType is a required column, never cleared). airflow and humidityCharacter ARE nullable —
// an explicit `null` clears them — so each is validated only when non-null.
export class UpdatePlaceDto {
  @ValidateIf((_, v) => v !== undefined) @IsString() @MinLength(1) name?: string;
  @ValidateIf((_, v) => v !== undefined) @IsBoolean() climateControlled?: boolean;
  @ValidateIf((_, v) => v !== undefined) @IsEnum(LightType) lightType?: LightType;
  @ValidateIf((_, v) => v !== undefined && v !== null) @IsEnum(HumidityCharacter) humidityCharacter?: HumidityCharacter | null;
  @ValidateIf((_, v) => v !== undefined && v !== null) @IsIn(AIRFLOW) airflow?: Airflow | null;
}
