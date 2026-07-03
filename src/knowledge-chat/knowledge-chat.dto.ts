import { IsString, MaxLength, MinLength } from 'class-validator';

// A research prompt. Capped generously (research prompts can be long) but bounded to avoid abuse.
export class CreateSessionDto {
  @IsString() @MinLength(1) @MaxLength(20_000) prompt!: string;
}

export class CreateRunDto {
  @IsString() @MinLength(1) @MaxLength(20_000) prompt!: string;
}
