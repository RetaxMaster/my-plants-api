import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';
import { HumidityCharacter, LightType } from '@prisma/client';

export class CreatePlaceDto {
  @IsString() @MinLength(1) cityId!: string;
  @IsString() @MinLength(1) name!: string;
  @IsBoolean() indoor!: boolean;
  @IsEnum(LightType) lightType!: LightType;
  @IsOptional() @IsBoolean() climateControlled?: boolean;
  @IsOptional() @IsEnum(HumidityCharacter) humidityCharacter?: HumidityCharacter;
  @IsOptional() @IsNumber() indoorTempMinC?: number | null;
  @IsOptional() @IsNumber() indoorTempMaxC?: number | null;
}
