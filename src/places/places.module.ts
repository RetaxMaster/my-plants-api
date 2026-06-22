import { Module } from '@nestjs/common';
import { CarePlanModule } from '../care-plan/care-plan.module.js';
import { PlacesController } from './places.controller.js';
import { PlacesService } from './places.service.js';

@Module({ imports: [CarePlanModule], controllers: [PlacesController], providers: [PlacesService], exports: [PlacesService] })
export class PlacesModule {}
