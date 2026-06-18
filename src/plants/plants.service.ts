import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreatePlantDto } from './create-plant.dto.js';

@Injectable()
export class PlantsService {
  constructor(private readonly prisma: PrismaService, private readonly owner: OwnerService) {}

  async list() {
    const ownerId = await this.owner.currentOwnerId();
    return this.prisma.plant.findMany({ where: { ownerId } });
  }

  async get(id: string) {
    const ownerId = await this.owner.currentOwnerId();
    const plant = await this.prisma.plant.findFirst({ where: { id, ownerId } });
    if (!plant) throw new NotFoundException(`Unknown plant: ${id}`);
    return plant;
  }

  async create(dto: CreatePlantDto) {
    const ownerId = await this.owner.currentOwnerId();
    const place = await this.prisma.place.findFirst({ where: { id: dto.placeId, ownerId } });
    if (!place) throw new BadRequestException(`Unknown place: ${dto.placeId}`);
    const species = await this.prisma.species.findUnique({ where: { slug: dto.speciesSlug } });
    if (!species) throw new BadRequestException(`Unknown species: ${dto.speciesSlug}`);

    return this.prisma.plant.create({
      data: {
        ownerId,
        placeId: dto.placeId,
        speciesSlug: dto.speciesSlug,
        nickname: dto.nickname,
        acquiredOn: new Date(dto.acquiredOn),
        // Optional per-task last-done dates become DONE events = the first-due anchors.
        events: dto.lastDone?.length
          ? { create: dto.lastDone.map((e) => ({ task: e.task, type: 'DONE' as const, occurredOn: new Date(e.doneOn) })) }
          : undefined,
      },
    });
  }
}
