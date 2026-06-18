import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CitiesService } from './cities.service.js';
import { CreateCityDto } from './create-city.dto.js';

@Controller('cities')
export class CitiesController {
  constructor(private readonly cities: CitiesService) {}

  @Get() list() { return this.cities.list(); }
  @Post() create(@Body() dto: CreateCityDto) { return this.cities.create(dto); }
  @Get(':id') get(@Param('id') id: string) { return this.cities.get(id); }
  @Post(':id/make-primary') makePrimary(@Param('id') id: string) { return this.cities.makePrimary(id); }
}
