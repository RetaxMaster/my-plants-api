import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Task } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { OwnerService } from '../owner/owner.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import type { SetFrequencyDto } from './frequency.dto.js';

// Frequency-bearing tasks only (PROGRESS excluded — fixed weekly cadence).
const FREQUENCY_TASKS = new Set<Task>([Task.WATER, Task.FERTILIZE, Task.REPOT, Task.ROTATE, Task.CLEAN_LEAVES, Task.MIST]);

@Injectable()
export class FrequencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly owner: OwnerService,
    private readonly carePlan: CarePlanService,
  ) {}

  async list(plantId: string) {
    await this.assertOwned(plantId);
    return this.prisma.plantTaskFrequency.findMany({
      where: { plantId },
      select: { task: true, intervalDays: true },
    });
  }

  async set(plantId: string, dto: SetFrequencyDto) {
    // Defense in depth: the DTO already rejects PROGRESS, but the service must also refuse it (and any
    // non-frequency-bearing task) so the invariant holds regardless of caller — never upsert a
    // PROGRESS PlantTaskFrequency the engine would ignore.
    if (!FREQUENCY_TASKS.has(dto.task)) {
      throw new BadRequestException(`Not a frequency-bearing task: ${dto.task}`);
    }
    await this.assertOwned(plantId);
    await this.prisma.plantTaskFrequency.upsert({
      where: { plantId_task: { plantId, task: dto.task } },
      create: { plantId, task: dto.task, intervalDays: dto.intervalDays },
      update: { intervalDays: dto.intervalDays },
    });
    await this.carePlan.recomputePlant(plantId); // the override substitution lives in the engine (Phase 2)
    return this.list(plantId);
  }

  async clear(plantId: string, task: string) {
    // The DELETE :task param is a raw string — validate it here (no DTO on a path param).
    if (!FREQUENCY_TASKS.has(task as Task)) {
      throw new BadRequestException(`Not a frequency-bearing task: ${task}`);
    }
    await this.assertOwned(plantId);
    await this.prisma.plantTaskFrequency.deleteMany({ where: { plantId, task: task as Task } });
    await this.carePlan.recomputePlant(plantId);
    return this.list(plantId);
  }

  private async assertOwned(plantId: string): Promise<void> {
    const owned = await this.prisma.plant.findFirst({
      where: { id: plantId, ...this.owner.ownerFilter() },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException(`Unknown plant: ${plantId}`);
  }
}
