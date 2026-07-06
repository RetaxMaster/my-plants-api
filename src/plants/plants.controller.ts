import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { plantProfileUpdateSchema, type PlantProfileUpdate } from '@retaxmaster/my-plants-species-schema';
import { imageUploadMulterOptions } from '../storage/multipart.config.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CreatePlantDto } from './create-plant.dto.js';
import { UpdatePlantDto } from './update-plant.dto.js';
import { PlantsService } from './plants.service.js';

@Controller('plants')
export class PlantsController {
  constructor(private readonly plants: PlantsService) {}

  @Get() list() { return this.plants.list(); }
  @Post() create(@Body() dto: CreatePlantDto) { return this.plants.create(dto); }
  @Get(':id/care') getCare(@Param('id') id: string) { return this.plants.getCare(id); }

  // Cover photo: multipart single file, field name `photo`, shared upload config.
  @Put(':id/cover-photo')
  @UseInterceptors(FileInterceptor('photo', imageUploadMulterOptions))
  setCover(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.plants.setCover(id, file);
  }

  @Delete(':id/cover-photo')
  deleteCover(@Param('id') id: string) {
    return this.plants.deleteCover(id);
  }

  // Physical profile: GET returns the all-null shape when unset; PATCH is a Zod-validated partial merge.
  @Get(':id/profile')
  getProfile(@Param('id') id: string) {
    return this.plants.getProfile(id);
  }

  @Get(':id/photos')
  getPhotos(@Param('id') id: string) {
    return this.plants.getPhotos(id);
  }

  @Patch(':id/profile')
  updateProfile(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(plantProfileUpdateSchema)) body: PlantProfileUpdate,
  ) {
    return this.plants.updateProfile(id, body);
  }

  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdatePlantDto) {
    return this.plants.update(id, dto);
  }

  @Get(':id/viability-preview') preview(@Param('id') id: string, @Query('placeId') placeId?: string) {
    if (!placeId) throw new BadRequestException('placeId is required');
    return this.plants.viabilityPreview(id, placeId);
  }

  @Get(':id') get(@Param('id') id: string) { return this.plants.get(id); }
}
