import { Env, SUBSCRIPTION_PLANS } from '../config';
import { FirestoreClient } from '../firebase/firestore';
import { AppError, ConflictError } from '../utils/errors';
import { addDays, nowIso, nowUtc } from '../utils/dates';

export class PaymentService {
  private env: Env;
  private firestore: FirestoreClient;

  constructor(env: Env, firestore: FirestoreClient) {
    this.env = env;
    this.firestore = firestore;
  }

  isConfigured(): boolean {
    return Boolean(
      this.env.RAZORPAY_KEY_ID &&
      this.env.RAZORPAY_KEY_SECRET &&
      this.env.RAZORPAY_KEY_ID.trim().length > 0 &&
      this.env.RAZORPAY_KEY_SECRET.trim().length > 0
    );
  }

  async createOrder(instituteId: string, planId: string, userUid: string) {
    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId);
    if (!plan) {
      throw new AppError(`Invalid plan ID: ${planId}`, 400);
    }

    if (!this.isConfigured()) {
      return {
        success: false,
        configured: false,
        code: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
        message:
          'Razorpay payment gateway credentials (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) are not configured on the backend. Subscriptions cannot be purchased yet. Please use the 7-day trial or contact institute administration.',
        planId: plan.id,
        amountINR: plan.priceINR,
      };
    }

    // Call Razorpay API to generate order
    const amountInPaise = plan.priceINR * 100;
    const authHeader = btoa(`${this.env.RAZORPAY_KEY_ID}:${this.env.RAZORPAY_KEY_SECRET}`);

    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authHeader}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountInPaise,
        currency: 'INR',
        receipt: `rcpt_${instituteId.substring(0, 8)}_${Date.now()}`,
        notes: {
          instituteId,
          planId: plan.id,
          requestedBy: userUid,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Razorpay order creation error:', err);
      throw new AppError('Failed to initialize payment order with gateway', 502);
    }

    const orderData = (await res.json()) as { id: string; amount: number; currency: string };

    // Record order in Firestore for plan and price binding verification
    await this.firestore.setDocument(`institutes/${instituteId}/subscription_orders/${orderData.id}`, {
      orderId: orderData.id,
      instituteId,
      planId: plan.id,
      amount: plan.priceINR,
      currency: 'INR',
      status: 'created',
      createdAt: nowIso(),
    });

    return {
      success: true,
      configured: true,
      orderId: orderData.id,
      keyId: this.env.RAZORPAY_KEY_ID,
      amount: orderData.amount,
      currency: orderData.currency,
      planId: plan.id,
      planName: plan.name,
    };
  }

  async verifyPayment(params: {
    instituteId: string;
    planId: string;
    paymentId: string;
    orderId: string;
    signature: string;
    userUid: string;
    idempotencyKey?: string;
  }) {
    const { instituteId, planId, paymentId, orderId, signature, userUid } = params;

    if (!paymentId || !orderId || !signature) {
      throw new AppError('Missing paymentId, orderId, or signature for verification', 400);
    }

    if (!this.isConfigured()) {
      return {
        success: false,
        configured: false,
        code: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
        message:
          'Payment verification is disabled: Razorpay credentials are not yet configured on the server. No fake activations are permitted.',
      };
    }

    // Validate plan exists
    const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId);
    if (!plan) {
      throw new AppError(`Invalid plan ID: ${planId}`, 400, 'INVALID_PLAN_ID');
    }

    // Verify HMAC-SHA256 signature first to guarantee cryptographic authenticity
    const secret = this.env.RAZORPAY_KEY_SECRET!;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const payload = `${orderId}|${paymentId}`;
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (expectedSignature.toLowerCase() !== signature.trim().toLowerCase()) {
      throw new AppError('Invalid payment signature verification failed', 400, 'INVALID_SIGNATURE');
    }

    const idempotencyKey = params.idempotencyKey || `pay_${paymentId}`;
    const idempotencyDocPath = `subscription_idempotency/${instituteId}_${idempotencyKey}`;

    // Check scoped idempotency cache with parameter binding validation
    const cachedIdempotency = await this.firestore.getDocument<{
      result: Record<string, unknown>;
      paymentId: string;
      orderId: string;
      instituteId: string;
      planId: string;
      createdAt: string;
    }>(idempotencyDocPath);

    if (cachedIdempotency?.result) {
      // Validate that stored parameters match incoming request exactly
      if (
        cachedIdempotency.paymentId !== paymentId ||
        cachedIdempotency.orderId !== orderId ||
        cachedIdempotency.instituteId !== instituteId ||
        (cachedIdempotency.planId && cachedIdempotency.planId !== plan.id)
      ) {
        throw new AppError(
          'Idempotency conflict: Reuse of existing idempotency key with mismatched payment parameters detected',
          409,
          'IDEMPOTENCY_CONFLICT'
        );
      }
      return cachedIdempotency.result;
    }

    // Verify plan & price binding against recorded order if present
    const orderDoc = await this.firestore.getDocument<{
      planId?: string;
      amount?: number;
      instituteId?: string;
    }>(`institutes/${instituteId}/subscription_orders/${orderId}`);

    if (orderDoc) {
      if (orderDoc.planId && orderDoc.planId !== plan.id) {
        throw new AppError(
          `Payment tampering detected: Order ${orderId} was created for plan '${orderDoc.planId}', but verification requested '${plan.id}'`,
          400,
          'PLAN_MISMATCH'
        );
      }
      if (orderDoc.amount && orderDoc.amount !== plan.priceINR) {
        throw new AppError(
          `Payment tampering detected: Order amount ₹${orderDoc.amount} does not match plan price ₹${plan.priceINR}`,
          400,
          'AMOUNT_MISMATCH'
        );
      }
    }

    // Check duplicate payment
    const existingPayment = await this.firestore.getDocument<{
      paymentId?: string;
      subscriptionId?: string;
    }>(`subscription_payments/${paymentId}`);

    if (existingPayment) {
      throw new ConflictError(`Payment ${paymentId} has already been processed and activated`);
    }

    const startAt = nowUtc();
    const endAt = addDays(startAt, plan.durationDays);
    const subscriptionId = `sub_${instituteId}_${Date.now()}`;
    const licenseKey = `LIC-PAID-${plan.id.toUpperCase()}-${Date.now().toString().slice(-6)}`;

    const result = {
      success: true,
      configured: true,
      subscriptionId,
      licenseKey,
      planId: plan.id,
      status: 'active',
      validUntil: endAt.toISOString(),
    };

    // Concurrency-safe atomic commit with existence precondition on subscription_payments/${paymentId}
    try {
      await this.firestore.commitBatchWrites([
        {
          currentDocument: { exists: false },
          update: {
            name: `subscription_payments/${paymentId}`,
            fields: {
              paymentId,
              instituteId,
              orderId,
              razorpayPaymentId: paymentId,
              planId: plan.id,
              amount: plan.priceINR,
              currency: 'INR',
              status: 'captured',
              subscriptionId,
              verifiedAt: nowIso(),
              createdAt: nowIso(),
            },
          },
        },
        {
          update: {
            name: `subscriptions/${subscriptionId}`,
            fields: {
              subscriptionId,
              instituteId,
              planId: plan.id,
              planName: plan.name,
              amount: plan.priceINR,
              currency: 'INR',
              status: 'active',
              startAt: startAt.toISOString(),
              endAt: endAt.toISOString(),
              source: 'razorpay',
              paymentId,
              licenseKey,
              createdBy: userUid,
              createdAt: nowIso(),
              updatedAt: nowIso(),
            },
          },
        },
        {
          update: {
            name: `institutes/${instituteId}`,
            fields: {
              subscriptionStatus: 'active',
              activeSubscriptionId: subscriptionId,
              planTier: plan.id,
              licenseKey,
              updatedAt: nowIso(),
            },
            updateMask: [
              'subscriptionStatus',
              'activeSubscriptionId',
              'planTier',
              'licenseKey',
              'updatedAt',
            ],
          },
        },
        {
          update: {
            name: `institutes/${instituteId}/license/current`,
            fields: {
              licenseKey,
              planId: plan.id,
              status: 'active',
              isTrial: false,
              paymentId,
              activatedAt: startAt.toISOString(),
              validUntil: endAt.toISOString(),
              updatedAt: nowIso(),
            },
            updateMask: [
              'licenseKey',
              'planId',
              'status',
              'isTrial',
              'paymentId',
              'activatedAt',
              'validUntil',
              'updatedAt',
            ],
          },
        },
        {
          update: {
            name: `subscription_audit_logs/log_${Date.now()}`,
            fields: {
              action: 'PAYMENT_VERIFIED_SUBSCRIPTION_ACTIVATED',
              instituteId,
              performedBy: userUid,
              oldValue: 'pending_or_trial',
              newValue: `active_${plan.id}`,
              reason: `Razorpay payment verified: ${paymentId}`,
              timestamp: nowIso(),
            },
          },
        },
        {
          update: {
            name: idempotencyDocPath,
            fields: {
              result,
              paymentId,
              orderId,
              instituteId,
              planId: plan.id,
              createdAt: nowIso(),
            },
          },
        },
      ]);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        errMsg.includes('already exists') ||
        errMsg.includes('ALREADY_EXISTS') ||
        errMsg.includes('FAILED_PRECONDITION')
      ) {
        throw new ConflictError(`Payment ${paymentId} has already been processed and activated`);
      }
      throw err;
    }

    return result;
  }

  async processWebhook(rawBody: string, signatureHeader: string | null) {
    const webhookSecret = this.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret || webhookSecret.trim().length === 0) {
      throw new AppError('Razorpay webhook secret is not configured on the server', 503);
    }

    if (!signatureHeader) {
      throw new AppError('Missing X-Razorpay-Signature header', 400);
    }

    // Verify webhook HMAC-SHA256 signature
    const encoder = new TextEncoder();
    const keyData = encoder.encode(webhookSecret);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
    const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (expectedSignature.toLowerCase() !== signatureHeader.trim().toLowerCase()) {
      throw new AppError('Invalid webhook signature verification failed', 400, 'INVALID_WEBHOOK_SIGNATURE');
    }

    const event = JSON.parse(rawBody) as {
      event: string;
      payload?: {
        payment?: { entity?: Record<string, any> };
        order?: { entity?: Record<string, any> };
      };
    };

    // Log the incoming webhook event
    await this.firestore.setDocument(`subscription_audit_logs/webhook_${Date.now()}`, {
      action: `WEBHOOK_EVENT_${event.event.toUpperCase().replace(/\./g, '_')}`,
      event: event.event,
      timestamp: nowIso(),
    });

    if (event.event === 'payment.captured' || event.event === 'order.paid') {
      const paymentEntity = event.payload?.payment?.entity;
      const orderEntity = event.payload?.order?.entity;

      const paymentId = paymentEntity?.id;
      const orderId = paymentEntity?.order_id || orderEntity?.id;
      const instituteId = paymentEntity?.notes?.instituteId || orderEntity?.notes?.instituteId;
      const planId = paymentEntity?.notes?.planId || orderEntity?.notes?.planId || 'core99';

      if (paymentId && orderId && instituteId) {
        const existingPayment = await this.firestore.getDocument(`subscription_payments/${paymentId}`);
        if (!existingPayment) {
          const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId) || SUBSCRIPTION_PLANS[0];
          const startAt = nowUtc();
          const endAt = addDays(startAt, plan.durationDays);
          const subscriptionId = `sub_${instituteId}_${Date.now()}`;
          const licenseKey = `LIC-PAID-${plan.id.toUpperCase()}-${Date.now().toString().slice(-6)}`;

          await this.firestore.commitBatchWrites([
            {
              currentDocument: { exists: false },
              update: {
                name: `subscription_payments/${paymentId}`,
                fields: {
                  paymentId,
                  instituteId,
                  orderId,
                  planId: plan.id,
                  amount: plan.priceINR,
                  currency: 'INR',
                  status: 'captured',
                  source: 'webhook',
                  verifiedAt: nowIso(),
                  createdAt: nowIso(),
                },
              },
            },
            {
              update: {
                name: `institutes/${instituteId}`,
                fields: {
                  subscriptionStatus: 'active',
                  activeSubscriptionId: subscriptionId,
                  planTier: plan.id,
                  licenseKey,
                  updatedAt: nowIso(),
                },
                updateMask: [
                  'subscriptionStatus',
                  'activeSubscriptionId',
                  'planTier',
                  'licenseKey',
                  'updatedAt',
                ],
              },
            },
            {
              update: {
                name: `institutes/${instituteId}/license/current`,
                fields: {
                  licenseKey,
                  planId: plan.id,
                  status: 'active',
                  isTrial: false,
                  paymentId,
                  activatedAt: startAt.toISOString(),
                  validUntil: endAt.toISOString(),
                  updatedAt: nowIso(),
                },
                updateMask: [
                  'licenseKey',
                  'planId',
                  'status',
                  'isTrial',
                  'paymentId',
                  'activatedAt',
                  'validUntil',
                  'updatedAt',
                ],
              },
            },
          ]);
        }
      }
    }

    return { success: true, event: event.event, received: true };
  }
}
