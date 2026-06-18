import { Module } from '@nestjs/common';
import { PlantsController } from './plants.controller.js';
import { PlantsService } from './plants.service.js';

@Module({ controllers: [PlantsController], providers: [PlantsService], exports: [PlantsService] })
export class PlantsModule {}
