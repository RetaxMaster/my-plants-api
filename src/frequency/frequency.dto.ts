import { IsEnum, IsInt, IsNotIn, Max, Min } from 'class-validator';
import { Task } from '@prisma/client';

export class SetFrequencyDto {
  // Frequency-bearing tasks only — PROGRESS has a fixed weekly cadence and is rejected.
  @IsEnum(Task) @IsNotIn([Task.PROGRESS], { message: 'PROGRESS has a fixed weekly cadence' }) task!: Task;
  // Positive interval within a sane bound (1 day .. ~10 years).
  @IsInt() @Min(1) @Max(3650) intervalDays!: number;
}
