import { Body, Controller, Param, Post } from '@nestjs/common';
import { IsDateString, IsEnum, IsOptional, IsObject } from 'class-validator';
import { CareEventType, Task } from '@prisma/client';
import { FeedbackService } from './feedback.service.js';

class FeedbackDto {
  @IsEnum(Task) task!: Task;
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
