import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class CreateCityDto {
  @IsString() @MinLength(1) name!: string;
  @IsNumber() @Min(-90) @Max(90) latitude!: number;
  @IsNumber() @Min(-180) @Max(180) longitude!: number;
  @IsString() @MinLength(1) timezone!: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}
