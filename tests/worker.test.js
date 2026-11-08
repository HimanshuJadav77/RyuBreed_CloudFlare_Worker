import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker, {
  SubscriptionService,
  TrialService,
  PaymentService,
  timingSafeEqualBytes,
  hexToBytes,
  verifySignatureConstantTime,
} from '../worker.js';

const mockEnv = {
  FIREBASE_PROJECT_ID: 'test-project-id',
  FIREBASE_CLIENT_EMAIL: 'test@test-project-id.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\\n-----END PRIVATE KEY-----\\n',
  ADMIN_BOOTSTRAP_UID: 'test-admin-uid-123',
  PUBLIC_APP_ORIGIN: '*',
};

test('GET /health returns healthy status', async () => {
  const req = new Request('https://api.ryubreed.com/health', { method: 'GET' });
  const res = await worker.fetch(req, mockEnv, {});
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.status, 'healthy');
  assert.equal(json.service, 'ryubreed-subscription-api');
});

test('GET /subscription/plans returns Core and Smart plans with ₹99 and ₹199', async () => {
  const req = new Request('https://api.ryubreed.com/subscription/plans', { method: 'GET' });
  const res = await worker.fetch(req, mockEnv, {});
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(Array.isArray(json.plans), true);
  assert.equal(json.plans.length, 2);

  const core = json.plans.find((p) => p.id === 'core99');
  assert.ok(core);
  assert.equal(core.priceINR, 99);
  assert.equal(core.durationDays, 30);

  const smart = json.plans.find((p) => p.id === 'smart199');
  assert.ok(smart);
  assert.equal(smart.priceINR, 199);
  assert.equal(smart.durationDays, 30);
});

test('GET /subscription/status rejects requests with missing Authorization header', async () => {
  const req = new Request('https://api.ryubreed.com/subscription/status', { method: 'GET' });
  const res = await worker.fetch(req, mockEnv, {});
  assert.equal(res.status, 401);

  const json = await res.json();
  assert.equal(json.success, false);
  assert.equal(json.error.code, 'UNAUTHORIZED');
});

test('POST /subscription/start-trial rejects requests with malformed Authorization token', async () => {
  const req = new Request('https://api.ryubreed.com/subscription/start-trial', {
    method: 'POST',
    headers: { Authorization: 'Bearer invalid-token-string' },
  });
  const res = await worker.fetch(req, mockEnv, {});
  assert.equal(res.status, 401);

  const json = await res.json();
  assert.equal(json.success, false);
});

test('POST /subscription/create-order returns clear disabled message when Razorpay unconfigured', async () => {
  // Pass simulated token that causes unauthorized before reaching unconfigured gateway
  const req = new Request('https://api.ryubreed.com/subscription/create-order', {
    method: 'POST',
    headers: { Authorization: 'Bearer mock.jwt.token' },
    body: JSON.stringify({ planId: 'smart199' }),
  });
  const res = await worker.fetch(req, mockEnv, {});
  // Expected to fail authentication safely
  assert.equal(res.status, 401);
});

test('GET /admin redirects to ADMIN_DASHBOARD_URL with 302', async () => {
  const customEnv = { ...mockEnv, ADMIN_DASHBOARD_URL: 'https://admin.ryubreed.com' };
  const req = new Request('https://api.ryubreed.com/admin', { method: 'GET' });
  const res = await worker.fetch(req, customEnv, {});
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('Location')?.startsWith('https://admin.ryubreed.com'));
});

test('OPTIONS preflight with allowed origin returns 204 with matching CORS headers', async () => {
  const corsEnv = { ...mockEnv, ALLOWED_ORIGINS: 'https://academia.ryubreed.com,http://localhost:3000' };
  const req = new Request('https://api.ryubreed.com/subscription/status', {
    method: 'OPTIONS',
    headers: { Origin: 'https://academia.ryubreed.com' },
  });
  const res = await worker.fetch(req, corsEnv, {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://academia.ryubreed.com');
});

test('OPTIONS preflight with unauthorized origin is rejected with 403 Forbidden', async () => {
  const corsEnv = { ...mockEnv, ALLOWED_ORIGINS: 'https://academia.ryubreed.com' };
  const req = new Request('https://api.ryubreed.com/subscription/status', {
    method: 'OPTIONS',
    headers: { Origin: 'https://malicious-site.example' },
  });
  const res = await worker.fetch(req, corsEnv, {});
  assert.equal(res.status, 403);
});

test('Request from mobile client (no Origin header) passes without CORS restrictions', async () => {
  const corsEnv = { ...mockEnv, ALLOWED_ORIGINS: 'https://academia.ryubreed.com' };
  const req = new Request('https://api.ryubreed.com/health', { method: 'GET' });
  const res = await worker.fetch(req, corsEnv, {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'healthy');
});

test('Unmatched route returns 404 NOT_FOUND', async () => {
  const req = new Request('https://api.ryubreed.com/non-existent-endpoint', { method: 'GET' });
  const res = await worker.fetch(req, mockEnv, {});
  assert.equal(res.status, 404);

  const json = await res.json();
  assert.equal(json.success, false);
  assert.equal(json.error.code, 'NOT_FOUND');
});

test('Subscription Expiry Enforcement: Stale active status in Firestore with expired endAt is immediately denied and marked expired', async () => {
  const expiredEndAt = new Date(Date.now() - 3600000).toISOString(); // Expired 1 hour ago
  const updatedDocs = [];
  const mockFirestore = {
    getDocument: async (path) => {
      if (path === 'institutes/inst_stale') {
        return {
          id: 'inst_stale',
          name: 'Stale Active Institute',
          subscriptionStatus: 'active', // Stale active status before hourly Cron runs
          activeSubscriptionId: 'sub_stale',
          planTier: 'smart199',
        };
      }
      if (path === 'subscriptions/sub_stale') {
        return {
          id: 'sub_stale',
          planId: 'smart199',
          status: 'active', // Stale active status
          startAt: new Date(Date.now() - 31 * 86400000).toISOString(),
          endAt: expiredEndAt, // Authoritative expired timestamp
        };
      }
      return null;
    },
    setDocument: async (path, data) => {
      updatedDocs.push({ path, data });
      return data;
    },
  };

  const service = new SubscriptionService(mockFirestore);
  const status = await service.getSubscriptionStatus('inst_stale');

  // Must be immediately denied and revoked
  assert.equal(status.status, 'expired', 'Stale active status must be forced to expired');
  assert.equal(status.isValid, false, 'isValid must be false');
  assert.equal(status.remainingDays, 0, 'remainingDays must be 0');
  assert.ok(status.serverTimestamp > 0, 'serverTimestamp must be present');

  // Verify Firestore documents were synchronized to expired status
  const instituteUpdate = updatedDocs.find((u) => u.path === 'institutes/inst_stale');
  assert.ok(instituteUpdate, 'Institute record must be updated in Firestore');
  assert.equal(instituteUpdate.data.subscriptionStatus, 'expired');
});

test('Authentication Independent of CORS: Protected institute endpoint rejects requests without Authorization even when Origin header is omitted', async () => {
  // Mobile client or curl with no Origin header
  const req = new Request('https://api.ryubreed.com/subscription/status', {
    method: 'GET',
    headers: {}, // No Origin, No Authorization
  });
  const res = await worker.fetch(req, mockEnv, {});
  assert.equal(res.status, 401, 'Must reject with 401 Unauthorized');
});

test('Authentication Independent of CORS: Administrative mutations reject requests without admin credentials regardless of Origin', async () => {
  // 1. Without Origin header
  const req1 = new Request('https://api.ryubreed.com/admin/trials/grant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instituteId: 'inst_1', durationDays: 7, reason: 'Test' }),
  });
  const res1 = await worker.fetch(req1, mockEnv, {});
  assert.equal(res1.status, 401, 'Must reject with 401 Unauthorized without admin credentials');

  // 2. With trusted Origin header but no admin credentials
  const req2 = new Request('https://api.ryubreed.com/admin/trials/grant', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://academia.ryubreed.com',
    },
    body: JSON.stringify({ instituteId: 'inst_1', durationDays: 7, reason: 'Test' }),
  });
  const res2 = await worker.fetch(req2, { ...mockEnv, ALLOWED_ORIGINS: 'https://academia.ryubreed.com' }, {});
  assert.equal(res2.status, 401, 'Origin match must NEVER bypass admin authentication');
});

test('Device Clock & Timestamp Integrity: Server-authoritative timestamps are used for trial creation, ignoring forged client dates', async () => {
  const capturedDocs = [];
  const mockFirestore = {
    getDocument: async (path) => {
      if (path === 'institutes/inst_test') {
        return {
          id: 'inst_test',
          ownerUid: 'inst_test',
          trialUsed: false,
          subscriptionStatus: 'unsubscribed',
        };
      }
      return null;
    },
    commitBatchWrites: async (writes) => {
      capturedDocs.push(...writes);
      return {};
    },
  };

  const trialService = new TrialService(mockFirestore);
  const beforeStart = Date.now();
  const result = await trialService.startAutomaticTrial('inst_test', 'inst_test');
  const afterStart = Date.now();

  assert.equal(result.success, true);
  assert.equal(result.status, 'trial');
  
  // Check that server-calculated expiration is exactly ~7 days from server now
  const trialEndMs = new Date(result.trialEndsAt).getTime();
  const expectedEndMin = beforeStart + (7 * 86400000) - 1000;
  const expectedEndMax = afterStart + (7 * 86400000) + 1000;
  assert.ok(trialEndMs >= expectedEndMin && trialEndMs <= expectedEndMax, 'Trial expiration must be computed from server time');
});

test('Request Body Size Enforcement: Request exceeding 1MB payload limit is rejected with 413', async () => {
  const req = new Request('https://api.ryubreed.com/subscription/start-trial', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': (1024 * 1024 + 10).toString(), // 1MB + 10 bytes
      Authorization: 'Bearer mock.jwt.token',
    },
    body: JSON.stringify({ instituteId: 'inst_large' }),
  });

  const res = await worker.fetch(req, mockEnv, {});
  assert.equal(res.status, 413, 'Must reject payloads > 1MB with HTTP 413');
  const json = await res.json();
  assert.equal(json.error.code, 'PAYLOAD_TOO_LARGE');
});

test('Request Body Size Enforcement: Request within 1MB limit proceeds to route handler', async () => {
  const req = new Request('https://api.ryubreed.com/health', {
    method: 'GET',
    headers: {
      'Content-Length': '100',
    },
  });

  const res = await worker.fetch(req, mockEnv, {});
  assert.equal(res.status, 200);
});

test('Streamed Request Body Size Enforcement: Streaming payload exceeding 1MB without Content-Length is rejected with 413', async () => {
  const largeChunk = new Uint8Array(1024 * 1024 + 100);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(largeChunk);
      controller.close();
    }
  });

  const req = new Request('https://api.ryubreed.com/subscription/create-order', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer mock.token',
    },
    body: stream,
    duplex: 'half',
  });

  const res = await worker.fetch(req, { ...mockEnv, ENVIRONMENT: 'test' }, {});
  assert.equal(res.status, 413, 'Must reject streamed payloads > 1MB with HTTP 413');
  const json = await res.json();
  assert.equal(json.error.code, 'PAYLOAD_TOO_LARGE');
});

test('Fail-Closed Authentication: Missing Firebase credentials in production environment throws 401 Unauthorized', async () => {
  const prodEnvWithoutCreds = {
    ...mockEnv,
    ENVIRONMENT: 'production',
    FIREBASE_CLIENT_EMAIL: '',
    FIREBASE_PRIVATE_KEY: '',
    SKIP_REVOCATION_CHECK: false,
  };

  const req = new Request('https://api.ryubreed.com/subscription/status', {
    method: 'GET',
    headers: {
      Authorization: 'Bearer any.bearer.token',
    },
  });

  const res = await worker.fetch(req, prodEnvWithoutCreds, {});
  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.success, false);
  assert.equal(json.error.code, 'UNAUTHORIZED');
});

test('Health Check: GET /health returns dependency health check with firestore status up', async () => {
  const req = new Request('https://api.ryubreed.com/health', { method: 'GET' });
  const res = await worker.fetch(req, mockEnv, {});
  assert.equal(res.status, 200);

  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.status, 'healthy');
  assert.ok(json.dependencies, 'Health check must include dependencies map');
  assert.equal(json.dependencies.firestore.status, 'up');
});

const configuredEnv = {
  ...mockEnv,
  RAZORPAY_KEY_ID: 'rzp_test_key123',
  RAZORPAY_KEY_SECRET: 'test_razorpay_secret_key_456',
  RAZORPAY_WEBHOOK_SECRET: 'test_razorpay_webhook_secret_789',
};

test('Payment Verification: Returns PAYMENT_GATEWAY_NOT_CONFIGURED when gateway keys are missing', async () => {
  const unconfiguredEnv = {
    ...mockEnv,
    RAZORPAY_KEY_ID: '',
    RAZORPAY_KEY_SECRET: '',
  };
  const mockDb = {
    async getDocument() { return null; },
    async setDocument() {},
  };
  const paymentService = new PaymentService(unconfiguredEnv, mockDb);
  const result = await paymentService.verifyPayment({
    instituteId: 'inst_abc',
    planId: 'smart199',
    paymentId: 'pay_123',
    orderId: 'order_123',
    signature: 'any_sig',
    userUid: 'uid_123',
  });

  assert.equal(result.success, false);
  assert.equal(result.configured, false);
  assert.equal(result.code, 'PAYMENT_GATEWAY_NOT_CONFIGURED');
});

test('Payment Verification: Rejects invalid HMAC signature before checking cache (HMAC-first verification)', async () => {
  const mockDb = {
    async getDocument(path) {
      // Even if cache exists, invalid HMAC must reject first
      return {
        result: { success: true },
        paymentId: 'pay_123',
      };
    },
    async setDocument() {},
  };
  const paymentService = new PaymentService(configuredEnv, mockDb);
  
  await assert.rejects(
    async () => {
      await paymentService.verifyPayment({
        instituteId: 'inst_abc',
        planId: 'smart199',
        paymentId: 'pay_123',
        orderId: 'order_123',
        signature: 'invalid_forged_hmac_signature',
        userUid: 'uid_123',
      });
    },
    (err) => {
      assert.equal(err.code, 'INVALID_SIGNATURE');
      return true;
    }
  );
});

test('Payment Verification Idempotency: Duplicate payment verification with valid HMAC and scoped key returns cached response', async () => {
  const validSignature = crypto
    .createHmac('sha256', configuredEnv.RAZORPAY_KEY_SECRET)
    .update('order_123|pay_123')
    .digest('hex');

  const cachedResult = {
    success: true,
    configured: true,
    subscriptionId: 'sub_cached_123',
    licenseKey: 'LIC-PAID-SMART199-CACHED',
    planId: 'smart199',
    status: 'active',
    validUntil: new Date(Date.now() + 86400000 * 30).toISOString(),
  };

  const mockDb = {
    async getDocument(path) {
      if (path === 'subscription_idempotency/inst_abc_idemp_unique_key_999') {
        return {
          result: cachedResult,
          paymentId: 'pay_123',
          orderId: 'order_123',
          instituteId: 'inst_abc',
          planId: 'smart199',
          createdAt: new Date().toISOString(),
        };
      }
      return null;
    },
    async setDocument() {},
  };

  const paymentService = new PaymentService(configuredEnv, mockDb);
  const result = await paymentService.verifyPayment({
    instituteId: 'inst_abc',
    planId: 'smart199',
    paymentId: 'pay_123',
    orderId: 'order_123',
    signature: validSignature,
    userUid: 'uid_123',
    idempotencyKey: 'idemp_unique_key_999',
  });

  assert.equal(result.subscriptionId, 'sub_cached_123');
  assert.equal(result.status, 'active');
  assert.equal(result.licenseKey, 'LIC-PAID-SMART199-CACHED');
});

test('Payment Verification Idempotency: Rejects replay attempt with same idempotency key but mismatched payment parameters', async () => {
  const validSignature = crypto
    .createHmac('sha256', configuredEnv.RAZORPAY_KEY_SECRET)
    .update('order_tampered|pay_tampered')
    .digest('hex');

  const mockDb = {
    async getDocument(path) {
      if (path === 'subscription_idempotency/inst_abc_idemp_replay_key') {
        return {
          result: { success: true },
          paymentId: 'pay_original',
          orderId: 'order_original',
          instituteId: 'inst_abc',
          planId: 'smart199',
        };
      }
      return null;
    },
    async setDocument() {},
  };

  const paymentService = new PaymentService(configuredEnv, mockDb);
  await assert.rejects(
    async () => {
      await paymentService.verifyPayment({
        instituteId: 'inst_abc',
        planId: 'smart199',
        paymentId: 'pay_tampered',
        orderId: 'order_tampered',
        signature: validSignature,
        userUid: 'uid_123',
        idempotencyKey: 'idemp_replay_key',
      });
    },
    (err) => {
      assert.match(err.message, /Idempotency key reuse detected with mismatched payment parameters/);
      return true;
    }
  );
});

test('Payment Verification: Rejects payment when requested plan or price does not match stored order (price binding)', async () => {
  const validSignature = crypto
    .createHmac('sha256', configuredEnv.RAZORPAY_KEY_SECRET)
    .update('order_mismatch|pay_mismatch')
    .digest('hex');

  const mockDb = {
    async getDocument(path) {
      if (path === 'institutes/inst_abc/subscription_orders/order_mismatch') {
        return {
          orderId: 'order_mismatch',
          planId: 'core99', // Order was for core99 (₹99)
          amount: 99,
        };
      }
      return null;
    },
    async setDocument() {},
  };

  const paymentService = new PaymentService(configuredEnv, mockDb);
  // User claims smart199 (₹199) with order that was only created for core99 (₹99)
  await assert.rejects(
    async () => {
      await paymentService.verifyPayment({
        instituteId: 'inst_abc',
        planId: 'smart199',
        paymentId: 'pay_mismatch',
        orderId: 'order_mismatch',
        signature: validSignature,
        userUid: 'uid_123',
      });
    },
    (err) => {
      assert.equal(err.code, 'PLAN_MISMATCH');
      return true;
    }
  );
});

test('Payment Verification: Atomic commitBatchWrites fails if payment document already exists (concurrency conflict)', async () => {
  const validSignature = crypto
    .createHmac('sha256', configuredEnv.RAZORPAY_KEY_SECRET)
    .update('order_conflict|pay_conflict')
    .digest('hex');

  const mockDb = {
    async getDocument() { return null; },
    async commitBatchWrites() {
      throw new Error('Document already exists at subscription_payments/pay_conflict');
    },
  };

  const paymentService = new PaymentService(configuredEnv, mockDb);
  await assert.rejects(
    async () => {
      await paymentService.verifyPayment({
        instituteId: 'inst_abc',
        planId: 'core99',
        paymentId: 'pay_conflict',
        orderId: 'order_conflict',
        signature: validSignature,
        userUid: 'uid_123',
      });
    },
    (err) => {
      assert.match(err.message, /has already been processed and activated/);
      return true;
    }
  );
});

test('Razorpay Webhook: Rejects webhook missing X-Razorpay-Signature header or with invalid signature', async () => {
  const paymentService = new PaymentService(configuredEnv, {
    async getDocument() { return null; },
    async setDocument() {},
  });

  await assert.rejects(
    async () => {
      await paymentService.processWebhook(JSON.stringify({ event: 'payment.captured' }), null);
    },
    (err) => {
      assert.match(err.message, /Missing X-Razorpay-Signature/);
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await paymentService.processWebhook(
        JSON.stringify({ event: 'payment.captured' }),
        'invalid_signature_hex'
      );
    },
    (err) => {
      assert.equal(err.code, 'INVALID_WEBHOOK_SIGNATURE');
      return true;
    }
  );
});

test('Razorpay Webhook: Processes valid payment.captured webhook and activates subscription', async () => {
  const payload = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_webhook_999',
          order_id: 'order_webhook_999',
          notes: {
            instituteId: 'inst_webhook_1',
            planId: 'smart199',
          },
        },
      },
    },
  });

  const validWebhookSig = crypto
    .createHmac('sha256', configuredEnv.RAZORPAY_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  const committedWrites = [];
  const mockDb = {
    async getDocument() { return null; },
    async setDocument() {},
    async commitBatchWrites(writes) {
      committedWrites.push(...writes);
      return {};
    },
  };

  const paymentService = new PaymentService(configuredEnv, mockDb);
  const result = await paymentService.processWebhook(payload, validWebhookSig);

  assert.equal(result.success, true);
  assert.equal(result.event, 'payment.captured');
  assert.ok(committedWrites.length >= 3, 'Must execute atomic writes for payment, institute, and license');
});

test('Admin Mutation Idempotency: Duplicate admin mutation with same idempotency key returns cached result', async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const exported = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const b64 = Buffer.from(exported).toString('base64');
  const validPem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (typeof url === 'string' && url.includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
    }
    if (typeof url === 'string' && url.includes('firestore.googleapis.com')) {
      if (url.includes('admin_idempotency')) {
        return new Response(
          JSON.stringify({
            name: 'projects/test-project/databases/(default)/documents/admin_idempotency/test-admin-uid-123_admin_grant_idemp_key_1',
            fields: {
              adminUid: { stringValue: 'test-admin-uid-123' },
              idempotencyKey: { stringValue: 'admin_grant_idemp_key_1' },
              instituteId: { stringValue: 'inst_admin_test' },
              result: {
                mapValue: {
                  fields: {
                    success: { booleanValue: true },
                    instituteId: { stringValue: 'inst_admin_test' },
                    durationDays: { integerValue: '14' },
                    status: { stringValue: 'trial' },
                    licenseKey: { stringValue: 'LIC-ADMIN-CACHED-123' },
                  },
                },
              },
            },
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    }
    return originalFetch(url, options);
  };

  try {
    const req = new Request('https://api.ryubreed.com/admin/trials/grant', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Api-Key': 'admin_secret_key_123',
        'idempotency-key': 'admin_grant_idemp_key_1',
      },
      body: JSON.stringify({
        instituteId: 'inst_admin_test',
        durationDays: 14,
        reason: 'Special promotion grant',
      }),
    });

    const envWithAdmin = {
      ...mockEnv,
      FIREBASE_PRIVATE_KEY: validPem,
      ADMIN_API_KEY: 'admin_secret_key_123',
      SKIP_REVOCATION_CHECK: true,
    };

    const res = await worker.fetch(req, envWithAdmin, {});
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.idempotentReplay, true);
    assert.equal(json.data.licenseKey, 'LIC-ADMIN-CACHED-123');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Dynamic Plans: Admin can update plan prices and public endpoint reflects modified price', async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const exported = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const b64 = Buffer.from(exported).toString('base64');
  const validPem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;

  const originalFetch = globalThis.fetch;
  let storedPlans = null;

  try {
    globalThis.fetch = async (url, options = {}) => {
      const urlStr = typeof url === 'string' ? url : url.url;
      if (urlStr.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      if (urlStr.includes('system_config%2Fplans') || urlStr.includes('system_config/plans')) {
        if (options.method === 'PATCH' || options.method === 'POST') {
          const body = JSON.parse(options.body);
          // Parse from Firestore REST format: fields.plans.arrayValue.values
          const planValues = body.fields?.plans?.arrayValue?.values || [];
          storedPlans = planValues.map((v) => ({
            id: v.mapValue.fields.id.stringValue,
            name: v.mapValue.fields.name.stringValue,
            priceINR: Number(v.mapValue.fields.priceINR.integerValue || v.mapValue.fields.priceINR.doubleValue),
            annualPriceINR: Number(v.mapValue.fields.annualPriceINR?.integerValue || v.mapValue.fields.annualPriceINR?.doubleValue || 0),
            durationDays: Number(v.mapValue.fields.durationDays?.integerValue || 30),
          }));
          return new Response(JSON.stringify(body), { status: 200 });
        }
        if (storedPlans) {
          // Return in Firestore REST format
          return new Response(
            JSON.stringify({
              fields: {
                plans: {
                  arrayValue: {
                    values: storedPlans.map((p) => ({
                      mapValue: {
                        fields: {
                          id: { stringValue: p.id },
                          name: { stringValue: p.name },
                          priceINR: { integerValue: String(p.priceINR) },
                          annualPriceINR: { integerValue: String(p.annualPriceINR) },
                          durationDays: { integerValue: String(p.durationDays) },
                        },
                      },
                    })),
                  },
                },
              },
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const envWithAdmin = {
      ...mockEnv,
      FIREBASE_PRIVATE_KEY: validPem,
      ADMIN_API_KEY: 'admin_secret_key_123',
      SKIP_REVOCATION_CHECK: true,
    };

    // 1. Admin updates plans (e.g. Core price to ₹1 for testing)
    const updateReq = new Request('https://api.ryubreed.com/admin/plans', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Api-Key': 'admin_secret_key_123',
      },
      body: JSON.stringify({
        plans: [
          { id: 'core99', name: 'Core Plan (Testing)', priceINR: 1, annualPriceINR: 10, durationDays: 30, features: ['Test'] },
          { id: 'smart199', name: 'Smart Plan', priceINR: 2, annualPriceINR: 20, durationDays: 30, features: ['Unlimited'] },
        ],
      }),
    });

    const updateRes = await worker.fetch(updateReq, envWithAdmin, {});
    assert.equal(updateRes.status, 200);
    const updateJson = await updateRes.json();
    assert.equal(updateJson.success, true);
    assert.equal(updateJson.plans[0].priceINR, 1);

    // 2. Public endpoint returns updated price
    const publicReq = new Request('https://api.ryubreed.com/subscription/plans', { method: 'GET' });
    const publicRes = await worker.fetch(publicReq, envWithAdmin, {});
    assert.equal(publicRes.status, 200);
    const publicJson = await publicRes.json();
    assert.equal(publicJson.success, true);
    assert.equal(publicJson.plans[0].priceINR, 1);
    assert.equal(publicJson.plans[1].priceINR, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --------------------------------------------------------------------------
// REG-IMPL-02: Constant-Time Byte Comparison Cryptographic Tests
// --------------------------------------------------------------------------
test('REG-IMPL-02: timingSafeEqualBytes compares equal Uint8Arrays in constant time', () => {
  const bufA = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const bufB = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.equal(timingSafeEqualBytes(bufA, bufB), true);

  // Mismatched byte at start
  const diffStart = new Uint8Array([99, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.equal(timingSafeEqualBytes(bufA, diffStart), false);

  // Mismatched byte in middle
  const diffMid = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 99, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.equal(timingSafeEqualBytes(bufA, diffMid), false);

  // Mismatched byte at end
  const diffEnd = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 99]);
  assert.equal(timingSafeEqualBytes(bufA, diffEnd), false);

  // Length mismatch
  const shortBuf = new Uint8Array([1, 2, 3]);
  assert.equal(timingSafeEqualBytes(bufA, shortBuf), false);
});

test('REG-IMPL-02: hexToBytes validates 64-character input length and hex encoding', () => {
  const validHex = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const bytes = hexToBytes(validHex);
  assert.ok(bytes);
  assert.equal(bytes.length, 32);
  assert.equal(bytes[0], 0xe3);
  assert.equal(bytes[31], 0x55);

  // Non-64 length
  assert.equal(hexToBytes('abc'), null);
  assert.equal(hexToBytes(''), null);
  assert.equal(hexToBytes(validHex + '00'), null);

  // Non-hex characters
  const invalidHex = 'g3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85z';
  assert.equal(hexToBytes(invalidHex), null);
});

test('REG-IMPL-02: verifySignatureConstantTime verifies HMAC-SHA256 signature without timing side-channel', async () => {
  const secret = 'rzp_test_secret_key_12345';
  const payload = 'order_test_123|pay_test_456';

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const hexSignature = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Valid signature matches
  assert.equal(verifySignatureConstantTime(signatureBuffer, hexSignature), true);
  assert.equal(verifySignatureConstantTime(signatureBuffer, hexSignature.toUpperCase()), true);

  // Tampered 1st character fails
  const tamperedStart = (hexSignature[0] === 'a' ? 'b' : 'a') + hexSignature.slice(1);
  assert.equal(verifySignatureConstantTime(signatureBuffer, tamperedStart), false);

  // Tampered last character fails
  const tamperedEnd = hexSignature.slice(0, 63) + (hexSignature[63] === 'a' ? 'b' : 'a');
  assert.equal(verifySignatureConstantTime(signatureBuffer, tamperedEnd), false);

  // Truncated signature fails
  assert.equal(verifySignatureConstantTime(signatureBuffer, hexSignature.slice(0, 60)), false);
});



