import { Env } from '../config';
import { FirestoreClient } from '../firebase/firestore';
import { FirebaseTokenPayload, verifyFirebaseIdToken } from '../auth/firebase-token';
import { SubscriptionService } from '../subscription/subscription-service';
import { TrialService } from '../subscription/trial-service';
import { PaymentService } from '../subscription/payment-service';
import { jsonResponse } from '../utils/response';
import { UnauthorizedError, ForbiddenError, AppError } from '../utils/errors';
import { assertRequiredString, parseJsonBody } from '../utils/validation';

async function authenticateRequest(
  request: Request,
  env: Env,
  clientSuppliedInstituteId?: string
): Promise<{ user: FirebaseTokenPayload; instituteId: string }> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header');
  }

  const token = authHeader.substring(7).trim();
  // Pass env for token revocation / account disabled check
  const user = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID, env);

  // Derive authoritative institute association from verified token
  const instituteId = user.uid;

  // Strict cross-institute IDOR authorization check
  if (
    clientSuppliedInstituteId &&
    clientSuppliedInstituteId.trim().length > 0 &&
    clientSuppliedInstituteId.trim() !== instituteId
  ) {
    throw new ForbiddenError(
      'Forbidden: Cross-institute access denied. Institute ID does not match authenticated user'
    );
  }

  return { user, instituteId };
}

export async function handleSubscriptionStatus(
  request: Request,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  const url = new URL(request.url);
  const queryInstId = url.searchParams.get('instituteId') || undefined;
  const { instituteId } = await authenticateRequest(request, env, queryInstId);
  const service = new SubscriptionService(firestore);
  const status = await service.getSubscriptionStatus(instituteId);

  return jsonResponse({ success: true, data: status }, 200, origin);
}

export async function handleStartTrial(
  request: Request,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  const body = await parseJsonBody(request);
  const { user, instituteId } = await authenticateRequest(
    request,
    env,
    body.instituteId as string | undefined
  );
  const trialService = new TrialService(firestore);
  const result = await trialService.startAutomaticTrial(instituteId, user.uid);

  return jsonResponse({ success: true, data: result }, 200, origin);
}

export async function handleRefreshSubscription(
  request: Request,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  const url = new URL(request.url);
  const queryInstId = url.searchParams.get('instituteId') || undefined;
  const { instituteId } = await authenticateRequest(request, env, queryInstId);
  const service = new SubscriptionService(firestore);
  const status = await service.getSubscriptionStatus(instituteId);

  return jsonResponse({ success: true, refreshed: true, data: status }, 200, origin);
}

export async function handleCreateOrder(
  request: Request,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  const body = await parseJsonBody(request);
  const { user, instituteId } = await authenticateRequest(
    request,
    env,
    body.instituteId as string | undefined
  );
  const planId = assertRequiredString(body.planId, 'planId');

  const paymentService = new PaymentService(env, firestore);
  const orderResult = await paymentService.createOrder(instituteId, planId, user.uid);

  return jsonResponse({ success: orderResult.success, data: orderResult }, 200, origin);
}

export async function handleVerifyPayment(
  request: Request,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  const body = await parseJsonBody(request);
  const { user, instituteId } = await authenticateRequest(
    request,
    env,
    body.instituteId as string | undefined
  );

  const planId = assertRequiredString(body.planId, 'planId');
  const paymentId = assertRequiredString(body.paymentId, 'paymentId');
  const orderId = assertRequiredString(body.orderId, 'orderId');
  const signature = assertRequiredString(body.signature, 'signature');
  const idempotencyKey = body.idempotencyKey as string | undefined;

  const paymentService = new PaymentService(env, firestore);
  const verifyResult = await paymentService.verifyPayment({
    instituteId,
    planId,
    paymentId,
    orderId,
    signature,
    userUid: user.uid,
    idempotencyKey,
  });

  return jsonResponse({ success: verifyResult.success, data: verifyResult }, 200, origin);
}

export async function handleRazorpayWebhook(
  request: Request,
  env: Env,
  firestore: FirestoreClient,
  origin = '*'
): Promise<Response> {
  const signatureHeader =
    request.headers.get('X-Razorpay-Signature') ||
    request.headers.get('x-razorpay-signature');
  const rawBody = await request.text();
  const paymentService = new PaymentService(env, firestore);
  const result = await paymentService.processWebhook(rawBody, signatureHeader);

  return jsonResponse({ success: true, data: result }, 200, origin);
}
