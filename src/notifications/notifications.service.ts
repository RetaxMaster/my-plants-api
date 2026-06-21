import { Injectable } from '@nestjs/common';
import { OwnerService } from '../owner/owner.service.js';
import { CarePlanService } from '../care-plan/care-plan.service.js';
import type { DueNotification, NotificationChannel } from './notification-channel.js';

// v1 in-app channel: exposes today's due tasks for the web to read. Email/push are future
// channels implementing the same NotificationChannel interface.
@Injectable()
export class InAppNotificationsService implements NotificationChannel {
  private latest: DueNotification[] = [];

  constructor(private readonly carePlan: CarePlanService, private readonly owner: OwnerService) {}

  async deliver(notifications: DueNotification[]): Promise<void> {
    this.latest = notifications;
  }

  async pending(): Promise<DueNotification[]> {
    // Per-actor: "my" due tasks. No admin bypass — notifications are personal, not a cross-owner
    // sweep. currentOwnerId() is synchronous now (reads CLS).
    const ownerId = this.owner.currentOwnerId();
    const due = await this.carePlan.todaysTasks(ownerId);
    return due.map((d) => ({ plantId: d.plantId, task: d.task, nextDueOn: d.nextDueOn }));
  }
}
