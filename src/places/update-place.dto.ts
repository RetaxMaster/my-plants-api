import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdatePlaceDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsBoolean() climateControlled?: boolean;
}
