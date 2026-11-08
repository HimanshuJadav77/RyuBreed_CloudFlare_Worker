import { Env } from './config';
import { FirestoreClient } from './firebase/firestore';
import { ExpiryService } from './subscription/expiry-service';
import { handleCors, resolveCorsOrigin, jsonResponse, errorResponse } from './utils/response';
import { handleHealth, handlePlans } from './routes/public-routes';
import {
  handleSubscriptionStatus,
  handleStartTrial,
  handleRefreshSubscription,
  handleCreateOrder,
  handleVerifyPayment,
  handleRazorpayWebhook,
} from './routes/subscription-routes';
import {
  handleAdminAnalytics,
  handleAdminInstitutes,
  handleAdminSubscriptions,
  handleAdminSubscriptionDetails,
  handleAdminGrantTrial,
  handleAdminExtendSubscription,
  handleAdminRevokeSubscription,
  handleAdminAuditLogs,
  handleAdminGetPlans,
  handleAdminUpdatePlans,
} from './routes/admin-routes';
import { createRateLimiter, rateLimitKeys } from './utils/rate-limiter';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const allowedOriginsConfig = env.ALLOWED_ORIGINS || env.PUBLIC_APP_ORIGIN;
    const cors = resolveCorsOrigin(request, allowedOriginsConfig);

    // 1. Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCors(request, allowedOriginsConfig);
    }

    // 2. Reject unauthorized browser origins for state-changing or data requests
    if (request.headers.get('Origin') && !cors.isAllowed) {
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'CORS origin not allowed by server policy',
          },
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const allowOrigin = cors.allowOriginHeader;
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    // 3. Request Body Size Enforcement (1MB max payload to prevent DoS)
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Request payload exceeds 1MB limit',
          },
        }),
        {
          status: 413,
          headers: {
            'Content-Type': 'application/json',
            ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
          },
        }
      );
    }

    // 4. Apply rate limiting based on route category
    const rateLimiter = createRateLimiter(env);
    let rateLimitResult: { allowed: boolean; headers: Record<string, string>; retryAfter?: number };
    
    if (path.startsWith('/admin/')) {
      rateLimitResult = await rateLimiter(request, rateLimitKeys.byUserId);
    } else if (path === '/subscription/webhook') {
      rateLimitResult = await rateLimiter(request, rateLimitKeys.byIp);
    } else if (path.startsWith('/subscription/')) {
      // For subscription routes, try to get instituteId from auth
      rateLimitResult = await rateLimiter(request, rateLimitKeys.byUserId);
    } else {
      // Public routes (health, plans)
      rateLimitResult = await rateLimiter(request, rateLimitKeys.byIp);
    }

    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please try again later.',
            retryAfter: rateLimitResult.retryAfter,
          },
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': (rateLimitResult.retryAfter || 60).toString(),
            ...rateLimitResult.headers,
            ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
          },
        }
      );
    }

    try {
      const firestore = new FirestoreClient(env);

      // Public routes
      if (path === '/health' && method === 'GET') {
        return await handleHealth(firestore, allowOrigin || '*');
      }
      if (path === '/subscription/plans' && method === 'GET') {
        return await handlePlans(firestore, allowOrigin || '*');
      }

      // Subscription authenticated routes
      if (path === '/subscription/status' && method === 'GET') {
        return await handleSubscriptionStatus(request, env, firestore, allowOrigin || '*');
      }
      if (path === '/subscription/start-trial' && method === 'POST') {
        return await handleStartTrial(request, env, firestore, allowOrigin || '*');
      }
      if (path === '/subscription/refresh' && method === 'POST') {
        return await handleRefreshSubscription(request, env, firestore, allowOrigin || '*');
      }
      if (path === '/subscription/create-order' && method === 'POST') {
        return await handleCreateOrder(request, env, firestore, allowOrigin || '*');
      }
      if (path === '/subscription/verify-payment' && method === 'POST') {
        return await handleVerifyPayment(request, env, firestore, allowOrigin || '*');
      }
      if (path === '/subscription/webhook' && method === 'POST') {
        return await handleRazorpayWebhook(request, env, firestore, allowOrigin || '*');
      }

      // Admin routes (Primary human UI is dedicated Node.js Dashboard)
      // GET /admin redirects directly to the configured ADMIN_DASHBOARD_URL
      if (path === '/admin' && method === 'GET') {
        const redirectUrl =
          env.ADMIN_DASHBOARD_URL && env.ADMIN_DASHBOARD_URL.trim().length > 0
            ? env.ADMIN_DASHBOARD_URL.trim()
            : 'http://localhost:3000';
        return Response.redirect(redirectUrl, 302);
      }

      if (path === '/admin/analytics' && method === 'GET') {
        return await handleAdminAnalytics(request, env, firestore, allowOrigin || '*');
      }
      if (path === '/admin/institutes' && method === 'GET') {
        return await handleAdminInstitutes(request, env, firestore, allowOrigin || '*');
      }
      if (path === '/admin/subscriptions' && method === 'GET') {
        return await handleAdminSubscriptions(request, env, firestore, allowOrigin || '*');
      }
      if (path.startsWith('/admin/subscriptions/') && method === 'GET') {
        const id = path.substring('/admin/subscriptions/'.length);
        return await handleAdminSubscriptionDetails(request, id, env, firestore, allowOrigin || '*');
      }
      if (path === '/admin/trials/grant' && method === 'POST') {
        return await handleAdminGrantTrial(request, env, firestore, allowOrigin || '*');
      }
      if (path === '/admin/subscriptions/extend' && method === 'POST') {
        return await handleAdminExtendSubscription(request, env, firestore, allowOrigin || '*');
      }
      if (path === '/admin/subscriptions/revoke' && method === 'POST') {
        return await handleAdminRevokeSubscription(request, env, firestore, allowOrigin || '*');
      }
      if (path === '/admin/plans' && method === 'GET') {
        return await handleAdminGetPlans(request, env, firestore, allowOrigin || '*');
      }
      if (path === '/admin/plans' && (method === 'PUT' || method === 'POST')) {
        return await handleAdminUpdatePlans(request, env, firestore, allowOrigin || '*');
      }
      if (path === '/admin/audit-logs' && method === 'GET') {
        return await handleAdminAuditLogs(request, env, firestore, allowOrigin || '*');
      }
      if (path === '/admin/cron/trigger-expiry' && method === 'POST') {
        const adminService = new ExpiryService(env, firestore);
        const result = await adminService.processDailyExpirations();
        return jsonResponse({ success: true, result }, 200, allowOrigin || '*');
      }

      // Not found
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Route ${method} ${path} not found on ryubreed-subscription-api`,
          },
        }),
        {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
          },
        }
      );
    } catch (err) {
      return errorResponse(err, allowOrigin);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[Cron Trigger] Hourly subscription expiry & reminder run started at ${new Date().toISOString()}`);
    const firestore = new FirestoreClient(env);
    const expiryService = new ExpiryService(env, firestore);

    ctx.waitUntil(
      expiryService
        .processDailyExpirations()
        .then((result) => {
          console.log(
            `[Cron Trigger] Complete. Processed: ${result.processed}, Expired: ${result.expired}, Notifications Sent: ${result.notificationsSent}`
          );
        })
        .catch((err) => {
          console.error('[Cron Trigger Error] Failed hourly processing:', err);
        })
    );
  },
};
