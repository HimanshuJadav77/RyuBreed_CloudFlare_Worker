import { FirestoreClient } from '../firebase/firestore';

export class AnalyticsService {
  private firestore: FirestoreClient;

  constructor(firestore: FirestoreClient) {
    this.firestore = firestore;
  }

  async getOverview() {
    const [institutes, subscriptions, payments] = await Promise.all([
      this.firestore.runQuery('institutes', [], 200),
      this.firestore.runQuery('subscriptions', [], 200),
      this.firestore.runQuery('subscription_payments', [], 200),
    ]);

    let activeSubscriptions = 0;
    let activeTrials = 0;
    let expiredSubscriptions = 0;
    let revokedSubscriptions = 0;
    let expiringSoon = 0;

    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    for (const inst of institutes) {
      const status = inst.subscriptionStatus as string | undefined;
      if (status === 'active') {
        activeSubscriptions++;
      } else if (status === 'trial') {
        activeTrials++;
      } else if (status === 'expired') {
        expiredSubscriptions++;
      } else if (status === 'revoked') {
        revokedSubscriptions++;
      }

      const endStr = (inst.trialEndsAt as string) || null;
      if (endStr) {
        const endMs = new Date(endStr).getTime();
        if (endMs > now && endMs - now <= sevenDaysMs) {
          expiringSoon++;
        }
      }
    }

    // Revenue calculation from verified payments
    let totalRevenueINR = 0;
    for (const p of payments) {
      const amount = Number(p.amount || 0);
      if (!isNaN(amount)) {
        totalRevenueINR += amount;
      }
    }

    return {
      totalInstitutes: institutes.length,
      activeSubscriptions,
      activeTrials,
      expiredSubscriptions,
      revokedSubscriptions,
      trialsExpiringSoon: expiringSoon,
      totalRevenueINR,
      verifiedPaymentsCount: payments.length,
      timestamp: new Date().toISOString(),
    };
  }
}

