import { Body, Controller, Post } from '@nestjs/common';
import { IsDateString, IsNumber, IsString, Max, Min, MinLength } from 'class-validator';
import { MovingService } from './moving.service.js';

class SimulateDto {
  @IsNumber() @Min(-90) @Max(90) latitude!: number;
  @IsNumber() @Min(-180) @Max(180) longitude!: number;
}

class ScheduleDto {
  @IsString() @MinLength(1) name!: string;
  @IsNumber() @Min(-90) @Max(90) latitude!: number;
  @IsNumber() @Min(-180) @Max(180) longitude!: number;
  @IsString() @MinLength(1) timezone!: string;
  @IsDateString() moveOn!: string;
}

@Controller('moving')
export class MovingController {
  constructor(private readonly moving: MovingService) {}

  @Post('simulate') simulate(@Body() dto: SimulateDto) {
    return this.moving.simulate(dto.latitude, dto.longitude);
  }

  @Post('schedule') schedule(@Body() dto: ScheduleDto) {
    return this.moving.schedule(
      { name: dto.name, latitude: dto.latitude, longitude: dto.longitude, timezone: dto.timezone },
      dto.moveOn,
    );
  }
}
