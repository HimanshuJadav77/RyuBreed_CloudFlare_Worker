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

export function handlePlans(origin = '*'): Response {
  return jsonResponse(
    {
      success: true,
      plans: SUBSCRIPTION_PLANS,
      trialDurationDays: 7,
    },
    200,
    origin
  );
}

