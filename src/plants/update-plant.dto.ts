import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdatePlantDto {
  @IsOptional() @IsString() nickname?: string; // "" / whitespace → cleared to null
  @IsOptional() @IsString() @MinLength(1) placeId?: string;
}
