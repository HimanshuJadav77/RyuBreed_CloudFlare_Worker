import { FirestoreClient } from '../firebase/firestore';
import { NotFoundError, AppError } from '../utils/errors';
import { addDays, nowIso } from '../utils/dates';

export class AdminService {
  private firestore: FirestoreClient;

  constructor(firestore: FirestoreClient) {
    this.firestore = firestore;
  }

  async listInstitutes(queryText?: string, limit = 50) {
    const list = await this.firestore.runQuery('institutes', [], limit);
    if (!queryText || queryText.trim().length === 0) {
      return list;
    }
    const q = queryText.toLowerCase().trim();
    return list.filter((inst) => {
      const name = String(inst.name || '').toLowerCase();
      const email = String(inst.email || '').toLowerCase();
      const id = String(inst._id || inst.id || '').toLowerCase();
      return name.includes(q) || email.includes(q) || id.includes(q);
    });
  }

  async listSubscriptions(statusFilter?: string, limit = 50) {
    const filters = statusFilter && statusFilter !== 'all'
      ? [{ field: 'status', op: 'EQUAL' as const, value: statusFilter }]
      : [];
    return this.firestore.runQuery('subscriptions', filters, limit);
  }

  async getSubscription(subscriptionId: string) {
    const sub = await this.firestore.getDocument(`subscriptions/${subscriptionId}`);
    if (!sub) {
      throw new NotFoundError(`Subscription ${subscriptionId} not found`);
    }
    return sub;
  }

  async extendSubscription(subscriptionId: string, days: number, reason: string, adminUid: string) {
    if (days <= 0 || days > 365) {
      throw new AppError('Extension days must be between 1 and 365', 400);
    }

    const sub = await this.firestore.getDocument<{
      instituteId?: string;
      endAt?: string;
      status?: string;
    }>(`subscriptions/${subscriptionId}`);

    if (!sub || !sub.instituteId) {
      throw new NotFoundError(`Subscription ${subscriptionId} not found`);
    }

    const now = new Date();
    const currentEnd = sub.endAt ? new Date(sub.endAt) : now;
    const baseDate = currentEnd.getTime() > now.getTime() ? currentEnd : now;
    const newEnd = addDays(baseDate, days);

    await this.firestore.commitBatchWrites([
      {
        update: {
          name: `subscriptions/${subscriptionId}`,
          fields: {
            endAt: newEnd.toISOString(),
            status: 'active',
            updatedAt: nowIso(),
          },
          updateMask: ['endAt', 'status', 'updatedAt'],
        },
      },
      {
        update: {
          name: `institutes/${sub.instituteId}`,
          fields: {
            subscriptionStatus: 'active',
            updatedAt: nowIso(),
          },
          updateMask: ['subscriptionStatus', 'updatedAt'],
        },
      },
      {
        update: {
          name: `institutes/${sub.instituteId}/license/current`,
          fields: {
            status: 'active',
            validUntil: newEnd.toISOString(),
            updatedAt: nowIso(),
          },
          updateMask: ['status', 'validUntil', 'updatedAt'],
        },
      },
      {
        update: {
          name: `subscription_audit_logs/log_${Date.now()}`,
          fields: {
            action: 'ADMIN_SUBSCRIPTION_EXTENDED',
            instituteId: sub.instituteId,
            performedBy: adminUid,
            oldValue: sub.endAt || 'none',
            newValue: newEnd.toISOString(),
            reason: reason || `Extended by ${days} days`,
            timestamp: nowIso(),
          },
        },
      },
    ]);

    return {
      success: true,
      subscriptionId,
      instituteId: sub.instituteId,
      newEndAt: newEnd.toISOString(),
    };
  }

  async listAuditLogs(limit = 100) {
    return this.firestore.runQuery('subscription_audit_logs', [], limit);
  }
}

