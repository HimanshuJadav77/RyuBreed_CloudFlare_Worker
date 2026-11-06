import { FirestoreClient } from '../firebase/firestore';
import { SUBSCRIPTION_PLANS } from '../config';
import { isPast, nowIso, remainingDays } from '../utils/dates';
import { NotFoundError } from '../utils/errors';

export interface AuthoritativeSubscriptionStatus {
  instituteId: string;
  instituteName: string;
  planId: string;
  planName: string;
  status: 'trial' | 'active' | 'expired' | 'revoked' | 'pending' | 'cancelled';
  isTrial: boolean;
  isValid: boolean;
  startAt: string | null;
  endAt: string | null;
  remainingDays: number;
  trialEligible: boolean;
  trialUsed: boolean;
  licenseKey: string | null;
  features: string[];
  serverTimestamp: number;
}

export class SubscriptionService {
  private firestore: FirestoreClient;

  constructor(firestore: FirestoreClient) {
    this.firestore = firestore;
  }

  async getSubscriptionStatus(instituteId: string): Promise<AuthoritativeSubscriptionStatus> {
    const institute = await this.firestore.getDocument<{
      name?: string;
      ownerUid?: string;
      trialUsed?: boolean;
      trialStartedAt?: string;
      trialEndsAt?: string;
      subscriptionStatus?: string;
      activeSubscriptionId?: string;
      planTier?: string;
      licenseKey?: string;
    }>(`institutes/${instituteId}`);

    if (!institute) {
      throw new NotFoundError(`Institute with ID ${instituteId} not found`);
    }

    const trialUsed = institute.trialUsed === true;
    let status = (institute.subscriptionStatus || 'expired') as
      | 'trial'
      | 'active'
      | 'expired'
      | 'revoked'
      | 'pending'
      | 'cancelled';

    let planId = institute.planTier || 'core99';
    let startAt: string | null = null;
    let endAt: string | null = null;
    let licenseKey = institute.licenseKey || null;

    // Check if active subscription record exists
    if (institute.activeSubscriptionId) {
      const sub = await this.firestore.getDocument<{
        planId?: string;
        status?: string;
        startAt?: string;
        endAt?: string;
        licenseKey?: string;
      }>(`subscriptions/${institute.activeSubscriptionId}`);

      if (sub) {
        planId = sub.planId || planId;
        status = (sub.status as any) || status;
        startAt = sub.startAt || null;
        endAt = sub.endAt || null;
        licenseKey = sub.licenseKey || licenseKey;
      }
    } else if (status === 'trial' || (!trialUsed && !institute.subscriptionStatus)) {
      startAt = institute.trialStartedAt || null;
      endAt = institute.trialEndsAt || null;
      planId = 'smart199'; // Trials grant full Smart Plan experience
    }

    // Authoritative server-side expiration validation
    const now = new Date();
    let remaining = 0;
    let isValid = false;

    if (endAt) {
      const expiryDate = new Date(endAt);
      remaining = remainingDays(expiryDate);

      if (isPast(expiryDate)) {
        if (status === 'trial' || status === 'active') {
          status = 'expired';
          // Immediately mark expired in Firestore to synchronize stale active records
          await this.firestore.setDocument(`institutes/${instituteId}`, {
            subscriptionStatus: 'expired',
            updatedAt: nowIso(),
          });
          await this.firestore.setDocument(`institutes/${instituteId}/license/current`, {
            status: 'expired',
            updatedAt: nowIso(),
          });
          if (institute.activeSubscriptionId) {
            await this.firestore.setDocument(`subscriptions/${institute.activeSubscriptionId}`, {
              status: 'expired',
              updatedAt: nowIso(),
            });
          }
        }
        isValid = false;
        remaining = 0;
      } else if (status === 'trial' || status === 'active') {
        isValid = true;
      }
    } else {
      if (status !== 'revoked') {
        status = 'expired';
      }
      isValid = false;
      remaining = 0;
    }

    if (status === 'revoked') {
      isValid = false;
      remaining = 0;
    }

    const matchedPlan = SUBSCRIPTION_PLANS.find((p) => p.id === planId) || SUBSCRIPTION_PLANS[0];
    const planName = status === 'trial' ? '7-Day Free Trial (Smart)' : matchedPlan.name;

    return {
      instituteId,
      instituteName: institute.name || 'RyuBreed Institute',
      planId,
      planName,
      status,
      isTrial: status === 'trial',
      isValid,
      startAt,
      endAt,
      remainingDays: remaining,
      trialEligible: !trialUsed,
      trialUsed,
      licenseKey,
      features: matchedPlan.features,
      serverTimestamp: Date.now(),
    };
  }
}

