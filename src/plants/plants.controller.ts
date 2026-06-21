import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreatePlantDto } from './create-plant.dto.js';
import { PlantsService } from './plants.service.js';

@Controller('plants')
export class PlantsController {
  constructor(private readonly plants: PlantsService) {}

  @Get() list() { return this.plants.list(); }
  @Post() create(@Body() dto: CreatePlantDto) { return this.plants.create(dto); }
  @Get(':id/care') getCare(@Param('id') id: string) { return this.plants.getCare(id); }
  @Get(':id') get(@Param('id') id: string) { return this.plants.get(id); }
}
