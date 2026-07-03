import { Controller, Get, Param } from '@nestjs/common';
import { SpeciesService } from './species.service.js';
import { Public } from '../auth/public.decorator.js';

@Controller('species')
export class SpeciesController {
  constructor(private readonly species: SpeciesService) {}

  // Public reference data: the catalog list is not owner-scoped, so the web app can show it
  // before/without a session. The full record (`one`) stays protected. (The blog is now served by
  // GET /blog and GET /blog/:slug — the old GET /species/:slug/brief is removed.)
  @Public()
  @Get()
  list() {
    return this.species.list();
  }

  @Get(':slug')
  one(@Param('slug') slug: string) {
    return this.species.record(slug);
  }
}
