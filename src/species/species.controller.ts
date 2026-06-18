import { Controller, Get, Param } from '@nestjs/common';
import { SpeciesService } from './species.service.js';

@Controller('species')
export class SpeciesController {
  constructor(private readonly species: SpeciesService) {}

  @Get()
  list() {
    return this.species.list();
  }

  @Get(':slug')
  one(@Param('slug') slug: string) {
    return this.species.record(slug);
  }
}
