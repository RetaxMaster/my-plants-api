import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CreatePlantDto } from './create-plant.dto.js';
import { UpdatePlantDto } from './update-plant.dto.js';
import { PlantsService } from './plants.service.js';

@Controller('plants')
export class PlantsController {
  constructor(private readonly plants: PlantsService) {}

  @Get() list() { return this.plants.list(); }
  @Post() create(@Body() dto: CreatePlantDto) { return this.plants.create(dto); }
  @Get(':id/care') getCare(@Param('id') id: string) { return this.plants.getCare(id); }

  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdatePlantDto) {
    return this.plants.update(id, dto);
  }

  @Get(':id/viability-preview') preview(@Param('id') id: string, @Query('placeId') placeId?: string) {
    if (!placeId) throw new BadRequestException('placeId is required');
    return this.plants.viabilityPreview(id, placeId);
  }

  @Get(':id') get(@Param('id') id: string) { return this.plants.get(id); }
}
