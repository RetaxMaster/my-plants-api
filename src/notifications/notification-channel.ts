export interface DueNotification {
  plantId: string;
  task: string;
  nextDueOn: Date;
}

export interface NotificationChannel {
  deliver(notifications: DueNotification[]): Promise<void>;
}
