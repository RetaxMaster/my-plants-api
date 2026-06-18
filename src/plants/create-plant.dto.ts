import { Type } from 'class-transformer';
import { ArrayUnique, IsArray, IsDateString, IsEnum, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { Task } from '@prisma/client';

export class LastDoneDto {
  @IsEnum(Task) task!: Task;
  @IsDateString() doneOn!: string;
}

export class CreatePlantDto {
  @IsString() @MinLength(1) placeId!: string;
  @IsString() @MinLength(1) speciesSlug!: string;
  @IsOptional() @IsString() nickname?: string;
  @IsDateString() acquiredOn!: string;
  @IsOptional() @IsArray() @ArrayUnique((d: LastDoneDto) => d.task)
  @ValidateNested({ each: true }) @Type(() => LastDoneDto)
  lastDone?: LastDoneDto[];
}
