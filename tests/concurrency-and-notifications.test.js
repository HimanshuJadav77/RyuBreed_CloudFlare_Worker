import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * In-memory Mock Firestore Client that implements:
 * - document storage
 * - precondition checks: currentDocument: { exists: false }
 * - atomic batch writes
 */
class MockFirestoreClient {
  constructor() {
    this.docs = new Map();
  }

  async getDocument(path) {
    if (!this.docs.has(path)) return null;
    return JSON.parse(JSON.stringify(this.docs.get(path)));
  }

  async setDocument(path, data) {
    const existing = this.docs.get(path) || {};
    const merged = { ...existing, ...data };
    this.docs.set(path, JSON.parse(JSON.stringify(merged)));
    return merged;
  }

  async createDocument(parentPath, collectionId, data) {
    const path = `${parentPath}/${collectionId}/${Date.now()}_${Math.random()}`;
    this.docs.set(path, data);
    return data;
  }

  async commitBatchWrites(writes) {
    // Atomic verification: check all preconditions first
    for (const w of writes) {
      if (w.currentDocument) {
        const docName = w.update?.name || w.delete;
        const cleanPath = docName.replace(/^projects\/[^/]+\/databases\/\(default\)\/documents\//, '');
        const exists = this.docs.has(cleanPath);
        if (w.currentDocument.exists === false && exists) {
          throw new Error(`Firestore commit error (400): Document already exists: ${cleanPath} (ALREADY_EXISTS)`);
        }
        if (w.currentDocument.exists === true && !exists) {
          throw new Error(`Firestore commit error (400): Document does not exist: ${cleanPath} (NOT_FOUND)`);
        }
      }
    }

    // Apply all writes atomically
    for (const w of writes) {
      if (w.update) {
        const docName = w.update.name;
        const cleanPath = docName.replace(/^projects\/[^/]+\/databases\/\(default\)\/documents\//, '');
        const existing = this.docs.get(cleanPath) || {};
        this.docs.set(cleanPath, { ...existing, ...w.update.fields });
      }
      if (w.delete) {
        const cleanPath = w.delete.replace(/^projects\/[^/]+\/databases\/\(default\)\/documents\//, '');
        this.docs.delete(cleanPath);
      }
    }
  }

  async runQuery(collectionId, filters) {
    const results = [];
    for (const [path, data] of this.docs.entries()) {
      if (path.startsWith(collectionId + '/')) {
        let match = true;
        if (filters && filters.length > 0) {
          for (const f of filters) {
            if (data[f.field] !== f.value) {
              match = false;
              break;
            }
          }
        }
        if (match) {
          results.push({ ...data, _id: path.split('/').pop() });
        }
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// TEST SUITE 1: Concurrency-Safe Trial Activation
// ---------------------------------------------------------------------------

test('TrialService: Prevents multiple trial periods under concurrent requests', async () => {
  // Import trial service from TypeScript build or load via worker source
  const mockDb = new MockFirestoreClient();
  const instituteId = 'inst_concurrent_01';
  const ownerUid = 'user_owner_01';

  // Seed institute document
  mockDb.docs.set(`institutes/${instituteId}`, {
    id: instituteId,
    ownerUid,
    name: 'Concurrent High School',
    subscriptionStatus: 'none',
    trialUsed: false,
  });

  // Dynamically import TrialService logic from standalone worker bundle
  const { TrialService } = await import('../worker.js');
  const service = new TrialService(mockDb);

  // Simulate two concurrent requests arriving at the exact same millisecond
  const [res1, res2] = await Promise.all([
    service.startAutomaticTrial(instituteId, ownerUid),
    service.startAutomaticTrial(instituteId, ownerUid),
  ]);

  // Both return a valid trial state
  assert.equal(res1.status, 'trial');
  assert.equal(res2.status, 'trial');

  // Exactly one trial record exists in subscription_trials
  assert.ok(mockDb.docs.has(`subscription_trials/${instituteId}`));

  // Trial dates match (no double period granted)
  assert.equal(res1.trialEndsAt, res2.trialEndsAt);

  // One of them is identified as existing trial returned idempotently
  assert.ok(res1.isExisting === true || res2.isExisting === true);

  // Verify that a third request after expiry is strictly rejected with ConflictError
  const trialDoc = mockDb.docs.get(`subscription_trials/${instituteId}`);
  // Force expire trial
  trialDoc.endAt = new Date(Date.now() - 10000).toISOString();
  mockDb.docs.set(`subscription_trials/${instituteId}`, trialDoc);
  const instDoc = mockDb.docs.get(`institutes/${instituteId}`);
  instDoc.trialEndsAt = trialDoc.endAt;
  mockDb.docs.set(`institutes/${instituteId}`, instDoc);

  await assert.rejects(
    async () => {
      await service.startAutomaticTrial(instituteId, ownerUid);
    },
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.ok(err.message.includes('already been consumed'));
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// TEST SUITE 2: Notification Reliability & Multi-State Markers
// ---------------------------------------------------------------------------

test('ExpiryService: Reliable notification delivery, retry on failure, and duplicate cron safety', async () => {
  const mockDb = new MockFirestoreClient();
  const instituteId = 'inst_notification_test';

  const { ExpiryService } = await import('../worker.js');

  // Mock environment with simulated fetch for FCM
  let fcmShouldFail = true;
  let fcmCallCount = 0;

  // Generate valid PKCS8 RSA test key so Web Crypto signs seamlessly
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

  const mockEnv = {
    FIREBASE_PROJECT_ID: 'test-project',
    FIREBASE_CLIENT_EMAIL: 'test@example.com',
    FIREBASE_PRIVATE_KEY: validPem,
  };

  // Seed FCM token
  mockDb.docs.set(`institutes/${instituteId}/settings/fcm`, {
    fcmToken: 'valid_device_fcm_token_123',
  });

  const service = new ExpiryService(mockEnv, mockDb);

  // Inject a mock sendFcmNotification by intercepting global fetch for FCM
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (typeof url === 'string' && url.includes('fcm.googleapis.com')) {
      fcmCallCount++;
      if (fcmShouldFail) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return new Response(JSON.stringify({ name: 'projects/test/messages/msg_123' }), { status: 200 });
    }
    // Return dummy token response for Google OAuth
    if (typeof url === 'string' && url.includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
    }
    return originalFetch(url, options);
  };

  try {
    // 1. First execution: FCM fails
    fcmShouldFail = true;
    const sent1 = await service.sendNotificationIfPending(
      instituteId,
      'reminder_7d',
      'Test Reminder',
      'Your subscription expires soon'
    );
    assert.equal(sent1, false, 'Failed FCM send must return false');

    const markerAfterFail = mockDb.docs.get(`institutes/${instituteId}/notification_markers/reminder_7d`);
    assert.equal(markerAfterFail.status, 'failed');
    assert.equal(markerAfterFail.fcmSent, false);
    assert.equal(markerAfterFail.attempts, 1);

    // 2. Retry after failure: FCM recovers and succeeds
    fcmShouldFail = false;
    const sent2 = await service.sendNotificationIfPending(
      instituteId,
      'reminder_7d',
      'Test Reminder',
      'Your subscription expires soon'
    );
    assert.equal(sent2, true, 'Retry after recovery must succeed');

    const markerAfterSuccess = mockDb.docs.get(`institutes/${instituteId}/notification_markers/reminder_7d`);
    assert.equal(markerAfterSuccess.status, 'sent');
    assert.equal(markerAfterSuccess.fcmSent, true);
    assert.equal(markerAfterSuccess.attempts, 2);

    // 3. Duplicate Cron execution: Next cron run sees status 'sent' and skips
    const initialCallCount = fcmCallCount;
    const sent3 = await service.sendNotificationIfPending(
      instituteId,
      'reminder_7d',
      'Test Reminder',
      'Your subscription expires soon'
    );
    assert.equal(sent3, false, 'Already delivered notification must be skipped on duplicate cron execution');
    assert.equal(fcmCallCount, initialCallCount, 'No redundant FCM network calls should be made');

    // 4. Invalid / Missing device token: institute without token handled gracefully
    const noTokenInstId = 'inst_no_token';
    const sentNoToken = await service.sendNotificationIfPending(
      noTokenInstId,
      'reminder_7d',
      'No Token Alert',
      'Alert for institute without registered mobile token'
    );
    assert.equal(sentNoToken, true);
    const noTokenMarker = mockDb.docs.get(`institutes/${noTokenInstId}/notification_markers/reminder_7d`);
    assert.equal(noTokenMarker.status, 'no_token');
    assert.equal(noTokenMarker.fcmSent, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// TEST SUITE 3: End-to-End Integration Flows
// ---------------------------------------------------------------------------

test('Integration Flow A: Token Validation → Firestore Subscription Lookup', async () => {
  const mockDb = new MockFirestoreClient();
  const instituteId = 'inst_flow_a';

  mockDb.docs.set(`institutes/${instituteId}`, {
    id: instituteId,
    name: 'Flow A Academy',
    subscriptionStatus: 'active',
    activeSubscriptionId: 'sub_flow_a',
    planTier: 'core99',
  });

  mockDb.docs.set(`subscriptions/sub_flow_a`, {
    subscriptionId: 'sub_flow_a',
    instituteId,
    planId: 'core99',
    status: 'active',
    endAt: new Date(Date.now() + 25 * 86400000).toISOString(),
    licenseKey: 'LIC-CORE-1234',
  });

  const { SubscriptionService } = await import('../worker.js');
  const service = new SubscriptionService(mockDb);

  const status = await service.getSubscriptionStatus(instituteId);
  assert.equal(status.instituteId, instituteId);
  assert.equal(status.status, 'active');
  assert.equal(status.planId, 'core99');
  assert.equal(status.isValid, true);
  assert.ok(status.remainingDays > 20);
});

test('Integration Flow B: Admin Trial Grant → License Activation → Subscription Refresh', async () => {
  const mockDb = new MockFirestoreClient();
  const instituteId = 'inst_flow_b';
  const adminUid = 'admin_super_user';

  mockDb.docs.set(`institutes/${instituteId}`, {
    id: instituteId,
    name: 'Flow B Academy',
    subscriptionStatus: 'none',
  });

  const { TrialService, SubscriptionService } = await import('../worker.js');

  const trialService = new TrialService(mockDb);
  const subService = new SubscriptionService(mockDb);

  // 1. Admin grants 14-day trial
  const grantResult = await trialService.grantAdminTrial(
    instituteId,
    14,
    'Approved pilot grant for school district',
    adminUid
  );
  assert.equal(grantResult.success, true);
  assert.equal(grantResult.durationDays, 14);

  // 2. Client / Flutter app refreshes subscription
  const status = await subService.getSubscriptionStatus(instituteId);
  assert.equal(status.status, 'trial');
  assert.equal(status.isTrial, true);
  assert.equal(status.isValid, true);
  assert.ok(status.remainingDays >= 13);
  assert.ok(mockDb.docs.has(`institutes/${instituteId}/license/current`));
});

test('Integration Flow C: Expiry Detection → Expired Status Set → Marker Created', async () => {
  const mockDb = new MockFirestoreClient();
  const instituteId = 'inst_flow_c';

  // Seed expired trial
  mockDb.docs.set(`institutes/${instituteId}`, {
    id: instituteId,
    name: 'Flow C Academy',
    subscriptionStatus: 'trial',
    trialEndsAt: new Date(Date.now() - 3600000).toISOString(), // Expired 1 hour ago
  });

  const mockEnv = {
    FIREBASE_PROJECT_ID: 'test-project',
    FIREBASE_CLIENT_EMAIL: 'test@example.com',
    FIREBASE_PRIVATE_KEY: 'test-key',
  };

  const { ExpiryService } = await import('../worker.js');
  const expiryService = new ExpiryService(mockEnv, mockDb);

  const report = await expiryService.processDailyExpirations();
  assert.equal(report.processed, 1);
  assert.equal(report.expired, 1);

  // Check that institute document was updated to expired
  const inst = mockDb.docs.get(`institutes/${instituteId}`);
  assert.equal(inst.subscriptionStatus, 'expired');

  // Check marker
  const marker = mockDb.docs.get(`institutes/${instituteId}/notification_markers/expiry_0d`);
  assert.ok(marker);
});
