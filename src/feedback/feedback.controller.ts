import { Body, Controller, Param, Post } from '@nestjs/common';
import { IsDateString, IsEnum, IsNotIn, IsOptional, IsObject } from 'class-validator';
import { CareEventType, Task } from '@prisma/client';
import { FeedbackService } from './feedback.service.js';

export class FeedbackDto {
  // PROGRESS is written ONLY by ProgressService (it has "completed by recording" semantics and its
  // scheduling must stay free of adjustment/override). Refuse it here so a client can never
  // Postpone/Symptom-nudge Progress into a stray PlantTaskAdjustment/TaskOverride.
  @IsEnum(Task) @IsNotIn([Task.PROGRESS], { message: 'PROGRESS is not a valid feedback task' }) task!: Task;
  @IsEnum(CareEventType) type!: CareEventType;
  @IsDateString() occurredOn!: string;
  @IsOptional() @IsDateString() postponeToOn?: string;
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
}

@Controller('plants/:id/feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Post()
  async record(@Param('id') plantId: string, @Body() dto: FeedbackDto) {
    await this.feedback.record({
      plantId,
      task: dto.task,
      type: dto.type,
      occurredOn: new Date(dto.occurredOn),
      postponeToOn: dto.postponeToOn ? new Date(dto.postponeToOn) : undefined,
      payload: dto.payload,
    });
    return { ok: true };
  }
}
