import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreatePlaceDto } from './create-place.dto.js';
import { PlacesService } from './places.service.js';

@Controller('places')
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get() list() { return this.places.list(); }
  @Post() create(@Body() dto: CreatePlaceDto) { return this.places.create(dto); }
  @Get(':id') get(@Param('id') id: string) { return this.places.get(id); }
}
