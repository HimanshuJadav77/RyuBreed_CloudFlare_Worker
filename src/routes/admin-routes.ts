import { Env } from '../config';
import { FirestoreClient } from '../firebase/firestore';
import { verifyFirebaseIdToken } from '../auth/firebase-token';
import { verifyAdminUser } from '../auth/admin-auth';
import { AdminService } from '../admin/admin-service';
import { AnalyticsService } from '../admin/analytics-service';
import { TrialService } from '../subscription/trial-service';
import { jsonResponse } from '../utils/response';
import { UnauthorizedError } from '../utils/errors';
import { assertRequiredNumber, assertRequiredString, parseJsonBody } from '../utils/validation';

async function authenticateAdmin(request: Request, env: Env, firestore: FirestoreClient) {
  const authHeader = request.headers.get('Authorization');
  const apiKeyHeader = request.headers.get('X-Admin-Api-Key');

  // 1. Direct Server-to-Server Authentication via ADMIN_API_KEY
  if (env.ADMIN_API_KEY && env.ADMIN_API_KEY.trim().length > 0) {
    const serverAdminUid = env.ADMIN_ID || env.ADMIN_UID || env.ADMIN_BOOTSTRAP_UID || 'node_admin_server';
    if (apiKeyHeader && apiKeyHeader.trim() === env.ADMIN_API_KEY.trim()) {
      return { uid: serverAdminUid, role: 'admin' };
    }
    if (authHeader && authHeader.startsWith('Bearer ') && authHeader.substring(7).trim() === env.ADMIN_API_KEY.trim()) {
      return { uid: serverAdminUid, role: 'admin' };
    }
  }

  // 2. Firebase ID Token Verification
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header');
  }

  const token = authHeader.substring(7).trim();
  // Pass env for token revocation / account disabled check
  const user = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID, env);
  await verifyAdminUser(user.uid, env, firestore);

  return user;
}

export async function handleAdminAnalytics(
  request: Request,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  await authenticateAdmin(request, env, firestore);
  const analytics = new AnalyticsService(firestore);
  const data = await analytics.getOverview();
  return jsonResponse({ success: true, data }, 200, origin);
}

export async function handleAdminInstitutes(
  request: Request,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  await authenticateAdmin(request, env, firestore);
  const url = new URL(request.url);
  const search = url.searchParams.get('search') || undefined;
  const adminService = new AdminService(firestore);
  const data = await adminService.listInstitutes(search);
  return jsonResponse({ success: true, count: data.length, data }, 200, origin);
}

export async function handleAdminSubscriptions(
  request: Request,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  await authenticateAdmin(request, env, firestore);
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || undefined;
  const adminService = new AdminService(firestore);
  const data = await adminService.listSubscriptions(status);
  return jsonResponse({ success: true, count: data.length, data }, 200, origin);
}

export async function handleAdminSubscriptionDetails(
  request: Request,
  subscriptionId: string,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  await authenticateAdmin(request, env, firestore);
  const adminService = new AdminService(firestore);
  const data = await adminService.getSubscription(subscriptionId);
  return jsonResponse({ success: true, data }, 200, origin);
}

export async function handleAdminGrantTrial(
  request: Request,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  const body = await parseJsonBody(request);
  const admin = await authenticateAdmin(request, env, firestore);

  const instituteId = assertRequiredString(body.instituteId, 'instituteId');
  const durationDays = assertRequiredNumber(body.durationDays, 'durationDays', 0.01);
  const reason = assertRequiredString(body.reason, 'reason');
  const idempotencyKey =
    (body.idempotencyKey as string | undefined) ||
    request.headers.get('idempotency-key') ||
    undefined;

  if (idempotencyKey && idempotencyKey.trim().length > 0) {
    const cacheKey = `admin_idempotency/${admin.uid}_${idempotencyKey.trim()}`;
    const cached = await firestore.getDocument<{ result?: any }>(cacheKey);
    if (cached?.result) {
      return jsonResponse(
        { success: true, data: cached.result, idempotentReplay: true },
        200,
        origin
      );
    }
    const trialService = new TrialService(firestore);
    const result = await trialService.grantAdminTrial(instituteId, durationDays, reason, admin.uid);
    await firestore.setDocument(cacheKey, {
      adminUid: admin.uid,
      idempotencyKey: idempotencyKey.trim(),
      instituteId,
      result,
      createdAt: new Date().toISOString(),
    });
    return jsonResponse({ success: true, data: result }, 200, origin);
  }

  const trialService = new TrialService(firestore);
  const result = await trialService.grantAdminTrial(instituteId, durationDays, reason, admin.uid);

  return jsonResponse({ success: true, data: result }, 200, origin);
}

export async function handleAdminExtendSubscription(
  request: Request,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  const body = await parseJsonBody(request);
  const admin = await authenticateAdmin(request, env, firestore);

  const subscriptionId = assertRequiredString(body.subscriptionId, 'subscriptionId');
  const days = assertRequiredNumber(body.days, 'days', 1);
  const reason = assertRequiredString(body.reason, 'reason');
  const idempotencyKey =
    (body.idempotencyKey as string | undefined) ||
    request.headers.get('idempotency-key') ||
    undefined;

  if (idempotencyKey && idempotencyKey.trim().length > 0) {
    const cacheKey = `admin_idempotency/${admin.uid}_${idempotencyKey.trim()}`;
    const cached = await firestore.getDocument<{ result?: any }>(cacheKey);
    if (cached?.result) {
      return jsonResponse(
        { success: true, data: cached.result, idempotentReplay: true },
        200,
        origin
      );
    }
    const adminService = new AdminService(firestore);
    const result = await adminService.extendSubscription(subscriptionId, days, reason, admin.uid);
    await firestore.setDocument(cacheKey, {
      adminUid: admin.uid,
      idempotencyKey: idempotencyKey.trim(),
      subscriptionId,
      result,
      createdAt: new Date().toISOString(),
    });
    return jsonResponse({ success: true, data: result }, 200, origin);
  }

  const adminService = new AdminService(firestore);
  const result = await adminService.extendSubscription(subscriptionId, days, reason, admin.uid);

  return jsonResponse({ success: true, data: result }, 200, origin);
}

export async function handleAdminRevokeSubscription(
  request: Request,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  const body = await parseJsonBody(request);
  const admin = await authenticateAdmin(request, env, firestore);

  const instituteId = assertRequiredString(body.instituteId, 'instituteId');
  const reason = assertRequiredString(body.reason, 'reason');
  const idempotencyKey =
    (body.idempotencyKey as string | undefined) ||
    request.headers.get('idempotency-key') ||
    undefined;

  if (idempotencyKey && idempotencyKey.trim().length > 0) {
    const cacheKey = `admin_idempotency/${admin.uid}_${idempotencyKey.trim()}`;
    const cached = await firestore.getDocument<{ result?: any }>(cacheKey);
    if (cached?.result) {
      return jsonResponse(
        { success: true, data: cached.result, idempotentReplay: true },
        200,
        origin
      );
    }
    const trialService = new TrialService(firestore);
    const result = await trialService.revokeSubscription(instituteId, reason, admin.uid);
    await firestore.setDocument(cacheKey, {
      adminUid: admin.uid,
      idempotencyKey: idempotencyKey.trim(),
      instituteId,
      result,
      createdAt: new Date().toISOString(),
    });
    return jsonResponse({ success: true, data: result }, 200, origin);
  }

  const trialService = new TrialService(firestore);
  const result = await trialService.revokeSubscription(instituteId, reason, admin.uid);

  return jsonResponse({ success: true, data: result }, 200, origin);
}

export async function handleAdminAuditLogs(
  request: Request,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  await authenticateAdmin(request, env, firestore);
  const adminService = new AdminService(firestore);
  const data = await adminService.listAuditLogs();
  return jsonResponse({ success: true, count: data.length, data }, 200, origin);
}

