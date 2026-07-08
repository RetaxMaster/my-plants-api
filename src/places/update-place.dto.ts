import { IsBoolean, IsIn, IsString, MinLength, ValidateIf } from 'class-validator';
import { AIRFLOW, type Airflow } from '@retaxmaster/my-plants-species-schema';

// ValidateIf (value !== undefined) instead of @IsOptional(): an absent field is skipped, but an explicit
// value is validated. name/climateControlled are optional-not-nullable (an explicit null is rejected).
// airflow IS nullable — an explicit `null` clears it — so it is validated only when non-null.
export class UpdatePlaceDto {
  @ValidateIf((_, v) => v !== undefined) @IsString() @MinLength(1) name?: string;
  @ValidateIf((_, v) => v !== undefined) @IsBoolean() climateControlled?: boolean;
  @ValidateIf((_, v) => v !== undefined && v !== null) @IsIn(AIRFLOW) airflow?: Airflow | null;
}
