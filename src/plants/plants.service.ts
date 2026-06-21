import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import { startOfTodayUtc } from '../common/time/local-date.js';
import { careTaskStatus, type CareStatus } from './plant-care.js';
import type { Task } from '@prisma/client';
import type { CreatePlantDto } from './create-plant.dto.js';

@Injectable()
export class PlantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: OwnerService,
    private readonly carePlan: CarePlanService,
  ) {}

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

  // Read model for the plant page (spec A.5 / C.2). Phase A returns { plantId, tasks }; Phase C will
  // ADD a top-level `viability` field to this same object (pure addition — do not reshape this).
  async getCare(id: string): Promise<{
    plantId: string;
    tasks: { task: Task; nextDueOn: string; daysUntilDue: number; status: CareStatus }[];
  }> {
    const ownerId = await this.owner.currentOwnerId();
    const plant = await this.prisma.plant.findFirst({ where: { id, ownerId } });
    if (!plant) throw new NotFoundException(`Unknown plant: ${id}`);

    // If the cache is empty (e.g. plant created before any recompute), recompute on demand so the
    // page is never spuriously empty.
    let due = await this.prisma.dueCache.findMany({
      where: { plantId: id },
      select: { task: true, nextDueOn: true },
      orderBy: { nextDueOn: 'asc' },
    });
    if (due.length === 0) {
      await this.carePlan.recomputePlant(id);
      due = await this.prisma.dueCache.findMany({
        where: { plantId: id },
        select: { task: true, nextDueOn: true },
        orderBy: { nextDueOn: 'asc' },
      });
    }

    const primary = await this.prisma.city.findFirst({ where: { ownerId, isPrimary: true } });
    const startOfToday = startOfTodayUtc(primary?.timezone ?? 'UTC');

    const tasks = due.map((d) => {
      const { daysUntilDue, status } = careTaskStatus(d.nextDueOn, startOfToday);
      return {
        task: d.task,
        nextDueOn: formatYmd(d.nextDueOn),
        daysUntilDue,
        status,
      };
    });

    return { plantId: id, tasks };
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

// Render a @db.Date (UTC-midnight) as YYYY-MM-DD from its UTC calendar parts.
function formatYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
