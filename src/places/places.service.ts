import { Injectable, NotFoundException } from '@nestjs/common';
import type { HumidityCharacter, LightType } from '@prisma/client';
import { OwnerService } from '../owner/owner.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface PlaceInput {
  cityId: string;
  name: string;
  indoor: boolean;
  lightType: LightType;
  climateControlled?: boolean;
  humidityCharacter?: HumidityCharacter;
  indoorTempMinC?: number | null;
  indoorTempMaxC?: number | null;
}

@Injectable()
export class PlacesService {
  constructor(private readonly prisma: PrismaService, private readonly owner: OwnerService) {}

  async list() {
    const ownerId = await this.owner.currentOwnerId();
    return this.prisma.place.findMany({ where: { ownerId } });
  }

  async create(input: PlaceInput) {
    const ownerId = await this.owner.currentOwnerId();
    return this.prisma.place.create({ data: { ...input, ownerId } });
  }

  async get(id: string) {
    const ownerId = await this.owner.currentOwnerId();
    const place = await this.prisma.place.findFirst({ where: { id, ownerId } });
    if (!place) throw new NotFoundException(`Unknown place: ${id}`);
    return place;
  }
}
