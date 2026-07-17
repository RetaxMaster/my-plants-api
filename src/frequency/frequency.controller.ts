import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { DoctorAllowed } from '../auth/doctor-scope.decorator.js';
import { SetFrequencyDto } from './frequency.dto.js';
import { FrequencyService } from './frequency.service.js';

@Controller('plants/:id/frequency')
export class FrequencyController {
  constructor(private readonly frequency: FrequencyService) {}

  @Get() list(@Param('id') id: string) {
    return this.frequency.list(id);
  }

  // Doctor "move cycles" writes (Spec 3 §3.3 allowlist): pinned to :id === token.plantId by DoctorScopeGuard.
  @Put() @DoctorAllowed() set(@Param('id') id: string, @Body() dto: SetFrequencyDto) {
    return this.frequency.set(id, dto);
  }

  @Delete(':task') @DoctorAllowed() clear(@Param('id') id: string, @Param('task') task: string) {
    return this.frequency.clear(id, task);
  }
}
