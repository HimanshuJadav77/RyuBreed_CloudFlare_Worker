import { SUBSCRIPTION_PLANS } from '../config';
import { FirestoreClient } from '../firebase/firestore';
import { jsonResponse } from '../utils/response';
import { nowIso } from '../utils/dates';

export async function handleHealth(firestore?: FirestoreClient, origin = '*'): Promise<Response> {
  let firestoreHealth: { healthy: boolean; latencyMs?: number; error?: string } = { healthy: true, latencyMs: 0 };
  if (firestore) {
    firestoreHealth = await firestore.checkHealth();
  }

  const isHealthy = firestoreHealth.healthy;
  return jsonResponse(
    {
      success: isHealthy,
      status: isHealthy ? 'healthy' : 'degraded',
      service: 'ryubreed-subscription-api',
      timestamp: nowIso(),
      dependencies: {
        firestore: {
          status: isHealthy ? 'up' : 'down',
          latencyMs: firestoreHealth.latencyMs,
          ...(firestoreHealth.error ? { error: firestoreHealth.error } : {}),
        },
      },
    },
    isHealthy ? 200 : 503,
    origin
  );
}

export async function handlePlans(firestore?: FirestoreClient, origin = '*'): Promise<Response> {
  let plans = SUBSCRIPTION_PLANS;
  if (firestore) {
    try {
      const doc = await firestore.getDocument<{ plans?: any[] }>('system_config/plans');
      if (doc && Array.isArray(doc.plans) && doc.plans.length > 0) {
        plans = doc.plans as any;
      }
    } catch {
      // Fallback to static SUBSCRIPTION_PLANS on read error
    }
  }

  return jsonResponse(
    {
      success: true,
      plans,
      trialDurationDays: 7,
    },
    200,
    origin
  );
}

