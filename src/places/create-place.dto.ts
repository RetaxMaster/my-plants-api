import { IsBoolean, IsEnum, IsIn, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';
import { HumidityCharacter, LightType } from '@prisma/client';
import { AIRFLOW, type Airflow } from '@retaxmaster/my-plants-species-schema';

export class CreatePlaceDto {
  @IsString() @MinLength(1) cityId!: string;
  @IsString() @MinLength(1) name!: string;
  @IsBoolean() indoor!: boolean;
  @IsEnum(LightType) lightType!: LightType;
  @IsOptional() @IsBoolean() climateControlled?: boolean;
  @IsOptional() @IsEnum(HumidityCharacter) humidityCharacter?: HumidityCharacter;
  @IsOptional() @IsNumber() indoorTempMinC?: number | null;
  @IsOptional() @IsNumber() indoorTempMaxC?: number | null;
  @IsOptional() @IsIn(AIRFLOW) airflow?: Airflow; // still|some|breezy (validated against the shared vocab)
}
