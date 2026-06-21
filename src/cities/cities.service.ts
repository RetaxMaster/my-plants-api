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

  // Read: USER own-only, ADMIN all.
  async list() {
    return this.prisma.city.findMany({ where: { ...this.owner.ownerFilter() } });
  }

  // Create: stamp the acting actor's ownerId; the isPrimary reset is scoped to that SAME owner
  // (never {} — an ADMIN must not clear every owner's primary flag).
  async create(dto: CreateCityDto) {
    const ownerId = this.owner.currentOwnerId();
    return this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.city.updateMany({ where: { ownerId }, data: { isPrimary: false } });
      }
      return tx.city.create({ data: { ...dto, isPrimary: dto.isPrimary ?? false, ownerId } });
    });
  }

  // Read/access-check: USER own-only, ADMIN any.
  async get(id: string) {
    const city = await this.prisma.city.findFirst({ where: { id, ...this.owner.ownerFilter() } });
    if (!city) throw new NotFoundException(`Unknown city: ${id}`);
    return city;
  }

  // Per-owner sweep: load the target via get() (USER own-only, ADMIN any), then scope the
  // isPrimary reset to THAT CITY's owner — derived from the target resource, never {} and never
  // the actor. This lets an ADMIN flip another owner's primary without touching anyone else's.
  async makePrimary(id: string) {
    const city = await this.get(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.city.updateMany({ where: { ownerId: city.ownerId }, data: { isPrimary: false } });
      return tx.city.update({ where: { id }, data: { isPrimary: true } });
    });
  }
}
