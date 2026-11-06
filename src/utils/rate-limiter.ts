import { Env } from '../config';

/**
 * Rate limiter using Cloudflare KV for distributed rate limiting.
 * Falls back to in-memory map if KV not configured (development only).
 */

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  keyPrefix: string;
}

interface RateLimitInfo {
  count: number;
  resetTime: number;
}

const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  public: { maxRequests: 100, windowMs: 60 * 1000, keyPrefix: 'rl:pub:' },      // 100/min for public endpoints
  subscription: { maxRequests: 60, windowMs: 60 * 1000, keyPrefix: 'rl:sub:' },  // 60/min for subscription
  admin: { maxRequests: 30, windowMs: 60 * 1000, keyPrefix: 'rl:admin:' },       // 30/min for admin
  auth: { maxRequests: 10, windowMs: 60 * 1000, keyPrefix: 'rl:auth:' },         // 10/min for auth endpoints
};

let memoryStore = new Map<string, RateLimitInfo>();
const MEMORY_STORE_MAX_SIZE = 10000;

/**
 * Creates a rate limiter middleware for Cloudflare Worker.
 * Uses KV namespace if available (via env.RATE_LIMIT_KV), otherwise in-memory.
 */
export function createRateLimiter(env: Env, category: keyof typeof DEFAULT_LIMITS = 'public') {
  const config = DEFAULT_LIMITS[category];
  const kv = env.RATE_LIMIT_KV; // Optional KV namespace binding

  return async function rateLimit(
    request: Request,
    getKey: (req: Request) => string
  ): Promise<{ allowed: boolean; headers: Record<string, string>; retryAfter?: number }> {
    const key = config.keyPrefix + getKey(request);
    const now = Date.now();
    const windowStart = now - config.windowMs;

    let info: RateLimitInfo | undefined;

    if (kv) {
      try {
        const stored = await kv.get(key, { type: 'json' }) as RateLimitInfo | null;
        if (stored && stored.resetTime > now) {
          info = stored;
        }
      } catch (e) {
        console.warn('Rate limiter KV read failed, falling back to memory:', e);
      }
    } else {
      info = memoryStore.get(key);
      if (info && info.resetTime <= now) {
        info = undefined;
      }
    }

    if (!info) {
      info = { count: 0, resetTime: now + config.windowMs };
    }

    info.count++;

    const allowed = info.count <= config.maxRequests;
    const remaining = Math.max(0, config.maxRequests - info.count);
    const retryAfter = allowed ? undefined : Math.ceil((info.resetTime - now) / 1000);

    const headers: Record<string, string> = {
      'X-RateLimit-Limit': config.maxRequests.toString(),
      'X-RateLimit-Remaining': remaining.toString(),
      'X-RateLimit-Reset': Math.ceil(info.resetTime / 1000).toString(),
    };

    if (!allowed) {
      headers['Retry-After'] = retryAfter!.toString();
    }

    // Store updated info
    if (kv) {
      try {
        await kv.put(key, JSON.stringify(info), { expirationTtl: Math.ceil(config.windowMs / 1000) + 10 });
      } catch (e) {
        console.warn('Rate limiter KV write failed:', e);
      }
    } else {
      // Clean up old entries if memory store too large
      if (memoryStore.size > MEMORY_STORE_MAX_SIZE) {
        const cutoff = now - config.windowMs;
        for (const [k, v] of memoryStore.entries()) {
          if (v.resetTime < cutoff) {
            memoryStore.delete(k);
          }
        }
        // If still too large, clear oldest half
        if (memoryStore.size > MEMORY_STORE_MAX_SIZE) {
          const entries = Array.from(memoryStore.entries());
          entries.sort((a, b) => a[1].resetTime - b[1].resetTime);
          const toDelete = entries.slice(0, Math.floor(entries.length / 2));
          for (const [k] of toDelete) {
            memoryStore.delete(k);
          }
        }
      }
      memoryStore.set(key, info);
    }

    return { allowed, headers, retryAfter };
  };
}

/**
 * Default key extractors
 */
export const rateLimitKeys = {
  byIp: (request: Request) => {
    // Cloudflare sets CF-Connecting-IP header
    const ip = request.headers.get('CF-Connecting-IP') || 
               request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
               'unknown';
    return ip;
  },
  byUserId: (request: Request) => {
    // For authenticated routes, extract from JWT or custom header
    const auth = request.headers.get('Authorization');
    if (auth?.startsWith('Bearer ')) {
      // In production, decode JWT to get sub/uid
      // For now, use hash of token
      return 'user:' + auth.slice(7, 27);
    }
    return rateLimitKeys.byIp(request);
  },
  byInstituteId: (request: Request, instituteId?: string) => {
    if (instituteId) {
      return `inst:${instituteId}`;
    }
    return rateLimitKeys.byIp(request);
  },
};