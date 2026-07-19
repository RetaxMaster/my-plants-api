import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { SetFrequencyDto } from './frequency.dto.js';
import { FrequencyService } from './frequency.service.js';

@Controller('plants/:id/frequency')
export class FrequencyController {
  constructor(private readonly frequency: FrequencyService) {}

  @Get() list(@Param('id') id: string) {
    return this.frequency.list(id);
  }

  // Owner-only. The doctor CANNOT write cadences: it proposes `frequency.set` / `frequency.clear`
  // operations and the owner approves them (spec §10). Do not restore @DoctorAllowed() on either
  // handler — see test/plant-doctor-proposals.e2e-spec.ts.
  @Put() set(@Param('id') id: string, @Body() dto: SetFrequencyDto) {
    return this.frequency.set(id, dto);
  }

  @Delete(':task') clear(@Param('id') id: string, @Param('task') task: string) {
    return this.frequency.clear(id, task);
  }
}
