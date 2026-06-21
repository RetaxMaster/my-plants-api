import { Injectable, NotFoundException } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OpenMeteoGeocodingClient, type CitySearchResult } from '../weather/open-meteo.geocoding.client.js';
import type { CreateCityDto } from './create-city.dto.js';

@Injectable()
export class CitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: OwnerService,
    private readonly geocoding: OpenMeteoGeocodingClient,
  ) {}

  // Proxies the geocoding bank. Not owner-scoped: the candidate list is public reference
  // data, not the owner's saved cities. Degrades to [] (the client never throws).
  search(query: string): Promise<CitySearchResult[]> {
    return this.geocoding.search(query);
  }

  async list() {
    const ownerId = await this.owner.currentOwnerId();
    return this.prisma.city.findMany({ where: { ownerId } });
  }

  async create(dto: CreateCityDto) {
    const ownerId = await this.owner.currentOwnerId();
    return this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.city.updateMany({ where: { ownerId }, data: { isPrimary: false } });
      }
      return tx.city.create({ data: { ...dto, isPrimary: dto.isPrimary ?? false, ownerId } });
    });
  }

  async get(id: string) {
    const ownerId = await this.owner.currentOwnerId();
    const city = await this.prisma.city.findFirst({ where: { id, ownerId } });
    if (!city) throw new NotFoundException(`Unknown city: ${id}`);
    return city;
  }

  async makePrimary(id: string) {
    const ownerId = await this.owner.currentOwnerId();
    await this.get(id); // ensures ownership
    return this.prisma.$transaction(async (tx) => {
      await tx.city.updateMany({ where: { ownerId }, data: { isPrimary: false } });
      return tx.city.update({ where: { id }, data: { isPrimary: true } });
    });
  }
}
