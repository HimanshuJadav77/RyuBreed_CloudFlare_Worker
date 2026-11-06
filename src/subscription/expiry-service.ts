import { Env } from '../config';
import { FirestoreClient } from '../firebase/firestore';
import { sendFcmNotification } from '../firebase/fcm';
import { isPast, nowIso, remainingDays } from '../utils/dates';

export class ExpiryService {
  private env: Env;
  private firestore: FirestoreClient;

  constructor(env: Env, firestore: FirestoreClient) {
    this.env = env;
    this.firestore = firestore;
  }

  async processDailyExpirations(): Promise<{
    processed: number;
    expired: number;
    notificationsSent: number;
  }> {
    let processed = 0;
    let expired = 0;
    let notificationsSent = 0;

    // Query institutes that have trial or active status in batches
    const activeInstitutes = await this.firestore.runQuery(
      'institutes',
      [{ field: 'subscriptionStatus', op: 'EQUAL', value: 'active' }],
      100
    );

    const trialInstitutes = await this.firestore.runQuery(
      'institutes',
      [{ field: 'subscriptionStatus', op: 'EQUAL', value: 'trial' }],
      100
    );

    const candidates = [...activeInstitutes, ...trialInstitutes];

    for (const inst of candidates) {
      processed++;
      const instituteId = (inst._id as string) || (inst.id as string);
      if (!instituteId) continue;

      let endAt: string | null = (inst.trialEndsAt as string) || null;
      if (inst.activeSubscriptionId) {
        const sub = await this.firestore.getDocument<{ endAt?: string }>(
          `subscriptions/${inst.activeSubscriptionId}`
        );
        if (sub?.endAt) endAt = sub.endAt;
      }

      if (!endAt) continue;
      const expiryDate = new Date(endAt);
      const daysLeft = remainingDays(expiryDate);

      // Check if expired
      if (isPast(expiryDate)) {
        await this.firestore.setDocument(`institutes/${instituteId}`, {
          subscriptionStatus: 'expired',
          updatedAt: nowIso(),
        });
        await this.firestore.setDocument(`institutes/${instituteId}/license/current`, {
          status: 'expired',
          updatedAt: nowIso(),
        });
        expired++;

        // Send expiry notification with idempotency check
        const sent = await this.sendNotificationIfPending(
          instituteId,
          'expiry_0d',
          'Subscription Expired',
          'Your RyuBreed Academia subscription has expired. Renew to resume cloud operations.'
        );
        if (sent) notificationsSent++;
        continue;
      }

      // Pre-expiry notifications: 7 days, 2 days, 1 day (using resilient range brackets with marker deduplication)
      if (daysLeft <= 7 && daysLeft > 2) {
        const sent = await this.sendNotificationIfPending(
          instituteId,
          'reminder_7d',
          'Subscription Reminder',
          'Your RyuBreed Academia subscription expires in 7 days.'
        );
        if (sent) notificationsSent++;
      } else if (daysLeft <= 2 && daysLeft > 1) {
        const sent = await this.sendNotificationIfPending(
          instituteId,
          'reminder_2d',
          'Subscription Reminder',
          'Your RyuBreed Academia subscription expires in 2 days.'
        );
        if (sent) notificationsSent++;
      } else if (daysLeft <= 1 && daysLeft > 0) {
        const sent = await this.sendNotificationIfPending(
          instituteId,
          'reminder_1d',
          'Subscription Expiring Tomorrow',
          'Your RyuBreed Academia subscription expires tomorrow.'
        );
        if (sent) notificationsSent++;
      }
    }

    return { processed, expired, notificationsSent };
  }

  async sendNotificationIfPending(
    instituteId: string,
    markerKey: string,
    title: string,
    body: string
  ): Promise<boolean> {
    const markerPath = `institutes/${instituteId}/notification_markers/${markerKey}`;
    const existing = await this.firestore.getDocument<{
      markerKey?: string;
      status?: 'pending' | 'sending' | 'sent' | 'failed' | 'no_token';
      sentAt?: string;
      attempts?: number;
      lastAttemptAt?: string;
      error?: string;
      fcmSent?: boolean;
    }>(markerPath);

    // 1. If already successfully delivered or permanently marked:
    if (existing?.status === 'sent' || existing?.status === 'no_token' || existing?.fcmSent === true) {
      return false;
    }

    // 2. Concurrency protection: If currently 'sending' within last 5 minutes, do not overlap
    if (existing?.status === 'sending' && existing?.lastAttemptAt) {
      const elapsed = Date.now() - new Date(existing.lastAttemptAt).getTime();
      if (elapsed < 5 * 60 * 1000) {
        return false;
      }
    }

    // 3. Mark as 'sending' with incremented attempt count
    const attemptCount = (existing?.attempts || 0) + 1;
    await this.firestore.setDocument(markerPath, {
      markerKey,
      status: 'sending',
      attempts: attemptCount,
      lastAttemptAt: nowIso(),
      title,
      body,
    });

    // 4. Record in-app notification if first attempt
    if (attemptCount === 1) {
      await this.firestore
        .createDocument(`institutes/${instituteId}`, 'notifications', {
          title,
          message: body,
          type: 'subscription',
          createdAt: nowIso(),
          read: false,
        })
        .catch((e) => console.warn('In-app notification write notice:', e));
    }

    // 5. Fetch device FCM token if available (supports both settings/fcm and root institute doc)
    const deviceDoc = await this.firestore.getDocument<{ fcmToken?: string }>(
      `institutes/${instituteId}/settings/fcm`
    );
    const instDoc = await this.firestore.getDocument<{ fcmToken?: string }>(
      `institutes/${instituteId}`
    );
    const token = deviceDoc?.fcmToken || instDoc?.fcmToken;

    if (!token || token.trim().length === 0) {
      // No mobile device token registered; mark as 'no_token'
      await this.firestore.setDocument(markerPath, {
        markerKey,
        status: 'no_token',
        sentAt: nowIso(),
        title,
        body,
        fcmSent: false,
        note: 'No FCM device token registered for institute',
      });
      return true;
    }

    // 6. Deliver FCM notification
    const fcmSuccess = await sendFcmNotification(this.env, {
      token,
      title,
      body,
      data: {
        type: 'subscription_alert',
        instituteId,
      },
    });

    if (fcmSuccess) {
      // Successfully sent! Permanently mark as 'sent'
      await this.firestore.setDocument(markerPath, {
        markerKey,
        status: 'sent',
        sentAt: nowIso(),
        title,
        body,
        fcmSent: true,
        attempts: attemptCount,
      });
      return true;
    } else {
      // Failed! Mark as 'failed' so next Cron execution can retry
      await this.firestore.setDocument(markerPath, {
        markerKey,
        status: 'failed',
        lastFailureAt: nowIso(),
        title,
        body,
        fcmSent: false,
        attempts: attemptCount,
        error: 'FCM_DELIVERY_FAILED',
      });
      return false;
    }
  }
}

