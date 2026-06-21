import { Controller, Get, Param } from '@nestjs/common';
import { SpeciesService } from './species.service.js';
import { Public } from '../auth/public.decorator.js';

@Controller('species')
export class SpeciesController {
  constructor(private readonly species: SpeciesService) {}

  // Public reference data: the catalog list and the human-readable brief are not owner-scoped, so
  // the web app can show them before/without a session. The full record (`one`) stays protected.
  @Public()
  @Get()
  list() {
    return this.species.list();
  }

  @Get(':slug')
  one(@Param('slug') slug: string) {
    return this.species.record(slug);
  }

  @Public()
  @Get(':slug/brief')
  brief(@Param('slug') slug: string) {
    return this.species.brief(slug);
  }
}
