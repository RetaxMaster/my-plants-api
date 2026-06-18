import { Body, Controller, Post } from '@nestjs/common';
import { IsDateString, IsString, MinLength } from 'class-validator';
import { MovingService } from './moving.service.js';

class SimulateDto { @IsString() @MinLength(1) targetCityId!: string; }
class ScheduleDto {
  @IsString() @MinLength(1) targetCityId!: string;
  @IsDateString() moveOn!: string;
}

@Controller('moving')
export class MovingController {
  constructor(private readonly moving: MovingService) {}

  @Post('simulate') simulate(@Body() dto: SimulateDto) { return this.moving.simulate(dto.targetCityId); }
  @Post('schedule') schedule(@Body() dto: ScheduleDto) { return this.moving.schedule(dto.targetCityId, dto.moveOn); }
}
