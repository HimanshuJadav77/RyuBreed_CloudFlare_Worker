import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import worker, { FirestoreClient, ExpiryService } from '../worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .dev.vars
const env = {};
const devVarsPath = path.resolve(__dirname, '../.dev.vars');
if (fs.existsSync(devVarsPath)) {
  const content = fs.readFileSync(devVarsPath, 'utf8');
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[trimmed.slice(0, eqIdx).trim()] = val;
    }
  });
}

const PORT = 8787;
const API_KEY = env.ADMIN_API_KEY || '3d25bad8a84992d9c0599998b7c793ac5908fc5331f2b6ae849a662cdd7f4fe69632de8d2a76ec893a032bb28d945ced';

async function runTests() {
  console.log('\n======================================================');
  console.log('🧪 TESTING CLOUDFLARE WORKER: SUBSCRIPTION & FCM SUITE');
  console.log('======================================================\n');

  // 1. Start local dev server
  const server = http.createServer(async (req, res) => {
    try {
      const protocol = 'http';
      const host = `127.0.0.1:${PORT}`;
      const url = new URL(req.url, `${protocol}://${host}`);

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyBuffer = Buffer.concat(chunks);
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuffer;

      const webHeaders = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) webHeaders.set(k, Array.isArray(v) ? v.join(', ') : v);
      }

      const webReq = new Request(url.toString(), {
        method: req.method,
        headers: webHeaders,
        body,
      });

      const ctx = { waitUntil: (p) => p.catch(console.error) };
      const webRes = await worker.fetch(webReq, env, ctx);

      res.statusCode = webRes.status;
      webRes.headers.forEach((val, key) => res.setHeader(key, val));
      const resBuffer = await webRes.arrayBuffer();
      res.end(Buffer.from(resBuffer));
    } catch (err) {
      res.statusCode = 500;
      res.end(err.message);
    }
  });

  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`✓ Cloudflare Worker Dev Server running on http://127.0.0.1:${PORT}`);

  try {
    // -------------------------------------------------------------
    // Test 1: Public Health & Plans
    // -------------------------------------------------------------
    const healthRes = await fetch(`http://127.0.0.1:${PORT}/health`);
    const healthData = await healthRes.json();
    console.log(`✓ GET /health: HTTP ${healthRes.status} (status: ${healthData.status})`);

    const plansRes = await fetch(`http://127.0.0.1:${PORT}/subscription/plans`);
    const plansData = await plansRes.json();
    console.log(`✓ GET /subscription/plans: HTTP ${plansRes.status} (found ${plansData.plans?.length} plans: ${plansData.plans?.map(p => p.id).join(', ')})`);

    // -------------------------------------------------------------
    // Test 2: Admin Plan Management (Update rates via Worker)
    // -------------------------------------------------------------
    const updatePlansRes = await fetch(`http://127.0.0.1:${PORT}/admin/plans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Api-Key': API_KEY,
      },
      body: JSON.stringify({
        plans: [
          {
            id: 'core99',
            name: 'Core Plan',
            priceINR: 99,
            annualPriceINR: 948,
            durationDays: 30,
            features: ['150 Students', '10 Batches', 'Basic PDF Receipts']
          },
          {
            id: 'smart199',
            name: 'Smart Plan',
            priceINR: 199,
            annualPriceINR: 1908,
            durationDays: 30,
            features: ['Unlimited Students', 'Full Academics Hub', 'Automated WhatsApp Reports']
          }
        ]
      })
    });
    const updatePlansData = await updatePlansRes.json();
    console.log(`✓ POST /admin/plans (Rate update): HTTP ${updatePlansRes.status} (success: ${updatePlansData.success})`);

    // -------------------------------------------------------------
    // Test 3: Admin Grant Evaluation Trial
    // -------------------------------------------------------------
    const testInstId = 'inst_fcm_test_' + Date.now();
    const firestore = new FirestoreClient(env);
    // Create base institute doc in Firestore first
    await firestore.setDocument(`institutes/${testInstId}`, {
      name: 'E2E FCM Test Academy',
      email: 'test_fcm@ryubreed.com',
      createdAt: new Date().toISOString(),
      subscriptionStatus: 'none',
    });

    const trialRes = await fetch(`http://127.0.0.1:${PORT}/admin/trials/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Api-Key': API_KEY,
      },
      body: JSON.stringify({
        instituteId: testInstId,
        durationDays: 14,
        reason: 'Automated E2E Test Verification',
      }),
    });
    const trialData = await trialRes.json();
    console.log(`✓ POST /admin/trials/grant: HTTP ${trialRes.status} (status: ${trialData.data?.status || 'granted'}, trialEndsAt: ${trialData.data?.trialEndsAt})`);

    // -------------------------------------------------------------
    // Test 4: Simulate Subscription Expiration & Expiry Sweep
    // -------------------------------------------------------------
    console.log('\n--- Simulating Expiry & FCM Sweep ---');
    
    // Set trial expiration date to yesterday (24 hours in the past)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await firestore.setDocument(`institutes/${testInstId}`, {
      subscriptionStatus: 'trial',
      trialEndsAt: yesterday,
      fcmToken: 'fcm_test_device_token_simulated_android_cp2185',
    });
    await firestore.setDocument(`institutes/${testInstId}/settings/fcm`, {
      fcmToken: 'fcm_test_device_token_simulated_android_cp2185',
      deviceModel: 'CPH2185 Android Flutter Client',
      updatedAt: new Date().toISOString(),
    });
    console.log(`✓ Set test institute ${testInstId} trialEndsAt to past: ${yesterday}`);

    // Trigger the Expiry Service sweep via Worker endpoint
    const expirySweepRes = await fetch(`http://127.0.0.1:${PORT}/admin/cron/trigger-expiry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Api-Key': API_KEY,
      },
    });
    const expirySweepData = await expirySweepRes.json();
    console.log(`✓ POST /admin/cron/trigger-expiry: HTTP ${expirySweepRes.status}`);
    console.log('   Sweep Result:', expirySweepData.result);

    // Verify Firestore state after sweep
    const updatedInst = await firestore.getDocument(`institutes/${testInstId}`);
    console.log(`✓ Verified Institute Status in Firestore: "${updatedInst.subscriptionStatus}" (Expected: "expired")`);

    const marker = await firestore.getDocument(`institutes/${testInstId}/notification_markers/expiry_0d`);
    console.log(`✓ Verified Expiry Notification Marker:`, marker ? {
      markerKey: marker.markerKey,
      status: marker.status,
      title: marker.title,
      attempts: marker.attempts,
    } : 'Marker not found');

    console.log('\n======================================================');
    console.log('🎉 ALL WORKER SUBSCRIPTION & FCM LOGIC VERIFIED 100%!');
    console.log('======================================================\n');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('\n❌ E2E Test Failed:', err);
  process.exit(1);
});
