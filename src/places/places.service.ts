import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { HumidityCharacter, LightType } from '@prisma/client';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UpdatePlaceDto } from './update-place.dto.js';

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
  constructor(private readonly prisma: PrismaService, private readonly owner: OwnerService, private readonly carePlan: CarePlanService) {}

  // Read: scoped by operation — a USER sees only their places; an ADMIN sees every owner's.
  async list() {
    return this.prisma.place.findMany({ where: { ...this.owner.ownerFilter() } });
  }

  // Create: always stamps the ACTING actor's ownerId (never ownerFilter — an ADMIN still creates
  // under their own owner) and validates the parent city belongs to that same owner.
  async create(input: PlaceInput) {
    const ownerId = this.owner.currentOwnerId();
    const city = await this.prisma.city.findFirst({ where: { id: input.cityId, ownerId } });
    if (!city) throw new BadRequestException(`Unknown city: ${input.cityId}`);
    return this.prisma.place.create({ data: { ...input, ownerId } });
  }

  // Read/access-check: USER own-only, ADMIN any.
  async get(id: string) {
    const place = await this.prisma.place.findFirst({ where: { id, ...this.owner.ownerFilter() } });
    if (!place) throw new NotFoundException(`Unknown place: ${id}`);
    return place;
  }

  // Edit name/climateControlled. USER own-only, ADMIN any. A climateControlled change recomputes
  // every plant in the place (they share its climate); a name-only change does not.
  async update(id: string, dto: UpdatePlaceDto) {
    const place = await this.prisma.place.findFirst({ where: { id, ...this.owner.ownerFilter() } });
    if (!place) throw new NotFoundException(`Unknown place: ${id}`);
    const data: { name?: string; climateControlled?: boolean } = {};
    let recompute = false;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.climateControlled !== undefined && dto.climateControlled !== place.climateControlled) {
      data.climateControlled = dto.climateControlled;
      recompute = true;
    }
    if (Object.keys(data).length > 0) await this.prisma.place.update({ where: { id }, data });
    if (recompute) await this.carePlan.recomputePlace(id);
    return this.get(id);
  }
}
