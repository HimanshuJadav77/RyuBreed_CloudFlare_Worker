/**
 * Resolves CORS authorization for incoming requests.
 * 
 * Rules:
 * 1. Mobile apps (Android/iOS) and server-to-server requests do not send an Origin header.
 *    These non-browser requests are NEVER blocked by CORS.
 * 2. Browser requests supply an Origin header (e.g., https://academia.ryubreed.com).
 *    These must match ALLOWED_ORIGINS (comma-separated list).
 * 3. Wildcard '*' is strictly for local development and should not be used in production
 *    when authenticated browser sessions are active.
 */
export function resolveCorsOrigin(
  request: Request,
  allowedOriginsConfig?: string
): { isAllowed: boolean; allowOriginHeader: string | null } {
  const requestOrigin = request.headers.get('Origin');

  // Case 1: Non-browser client (Mobile app / Flutter native / Curl / Server-to-server)
  if (!requestOrigin) {
    return { isAllowed: true, allowOriginHeader: null };
  }

  const rawConfig = (allowedOriginsConfig || '').trim();
  const configured = rawConfig
    .split(',')
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);

  // If wild-card '*' configured (local development)
  if (configured.includes('*')) {
    return { isAllowed: true, allowOriginHeader: requestOrigin };
  }

  const reqLower = requestOrigin.toLowerCase();
  if (configured.includes(reqLower)) {
    return { isAllowed: true, allowOriginHeader: requestOrigin };
  }

  // Unauthorized browser origin
  return { isAllowed: false, allowOriginHeader: null };
}

export function jsonResponse(
  data: unknown,
  status = 200,
  allowOriginHeader: string | null = null
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
  };

  if (allowOriginHeader) {
    headers['Access-Control-Allow-Origin'] = allowOriginHeader;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With, X-Admin-Api-Key';
    headers['Vary'] = 'Origin';
  }

  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

export function errorResponse(
  error: unknown,
  allowOriginHeader: string | null = null
): Response {
  let status = 500;
  let message = 'Internal Server Error';
  let code = 'INTERNAL_ERROR';

  if (error && typeof error === 'object' && 'statusCode' in error) {
    const err = error as { statusCode: number; message: string; code?: string };
    status = err.statusCode || 400;
    message = err.message || 'Error occurred';
    code = err.code || 'BAD_REQUEST';
  } else if (error instanceof Error) {
    message = error.message;
  }

  // Sanitize sensitive errors in production
  if (status >= 500) {
    console.error('Unhandled internal exception:', error);
    message = 'An unexpected server error occurred. Please contact support.';
  }

  return jsonResponse(
    {
      success: false,
      error: {
        code,
        message,
      },
    },
    status,
    allowOriginHeader
  );
}

export function handleCors(
  request: Request,
  allowedOriginsConfig?: string
): Response {
  const { isAllowed, allowOriginHeader } = resolveCorsOrigin(request, allowedOriginsConfig);

  if (!isAllowed) {
    return new Response(
      JSON.stringify({
        success: false,
        error: { code: 'FORBIDDEN', message: 'CORS origin not allowed' },
      }),
      {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Admin-Api-Key',
    'Access-Control-Max-Age': '86400',
  };

  if (allowOriginHeader) {
    headers['Access-Control-Allow-Origin'] = allowOriginHeader;
    headers['Vary'] = 'Origin';
  }

  return new Response(null, {
    status: 204,
    headers,
  });
}
