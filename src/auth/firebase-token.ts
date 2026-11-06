import { UnauthorizedError } from '../utils/errors';
import { Env } from '../config';
import { getGoogleOAuthToken } from '../firebase/oauth';

export interface FirebaseTokenPayload {
  uid: string;
  email?: string;
  name?: string;
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  auth_time: number;
  [key: string]: unknown;
}

interface JwkKey {
  kty: string;
  alg: string;
  use: string;
  kid: string;
  n: string;
  e: string;
}

// Cache for revoked/disabled user checks (5 min TTL)
const revocationCache = new Map<string, { disabled: boolean; validSince?: number; expiresAt: number }>();
const REVOCATION_CACHE_TTL = 5 * 60 * 1000;

let cachedJwks: { keys: JwkKey[]; expiresAt: number } | null = null;
const cryptoKeyCache = new Map<string, CryptoKey>();

function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseJwtSection<T>(section: string): T {
  const bytes = base64UrlDecode(section);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

async function getGoogleJwks(): Promise<JwkKey[]> {
  const now = Date.now();
  if (cachedJwks && cachedJwks.expiresAt > now) {
    return cachedJwks.keys;
  }

  const res = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) {
    throw new UnauthorizedError('Failed to fetch Google public verification keys');
  }

  const cacheControl = res.headers.get('cache-control');
  let maxAge = 3600;
  if (cacheControl) {
    const match = cacheControl.match(/max-age=(\d+)/);
    if (match) maxAge = parseInt(match[1], 10);
  }

  const data = (await res.json()) as { keys: JwkKey[] };
  cachedJwks = {
    keys: data.keys,
    expiresAt: now + maxAge * 1000,
  };
  cryptoKeyCache.clear();
  return data.keys;
}

async function getCryptoKey(jwk: JwkKey): Promise<CryptoKey> {
  const cached = cryptoKeyCache.get(jwk.kid);
  if (cached) return cached;

  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: jwk.kty,
      alg: jwk.alg,
      use: jwk.use,
      n: jwk.n,
      e: jwk.e,
    } as JsonWebKey,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['verify']
  );

  cryptoKeyCache.set(jwk.kid, key);
  return key;
}

/**
 * Checks if a Firebase user account is disabled or token revoked.
 * Uses Firebase Auth REST API with service account.
 * Cached for 5 minutes to avoid excessive API calls.
 * STRICTLY FAILS CLOSED on API/network error to guarantee security.
 */
async function checkUserRevocation(env: Env, uid: string, authTime?: number): Promise<void> {
  // If service account is unconfigured:
  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    const isTestEnv = env.ENVIRONMENT === 'test' ||
                      env.SKIP_REVOCATION_CHECK === true ||
                      env.SKIP_REVOCATION_CHECK === 'true';
    if (isTestEnv) {
      return;
    }
    // FAIL CLOSED in production: missing credentials is an unrecoverable security misconfiguration
    throw new UnauthorizedError('Authentication verification service misconfigured in production: missing service account credentials');
  }

  const now = Date.now();
  const cached = revocationCache.get(uid);
  if (cached && cached.expiresAt > now) {
    if (cached.disabled) {
      throw new UnauthorizedError('Account has been disabled. Please contact support.');
    }
    if (cached.validSince && authTime && authTime < cached.validSince) {
      throw new UnauthorizedError('User session has been revoked. Please sign in again.');
    }
    return;
  }

  try {
    const accessToken = await getGoogleOAuthToken(env);
    const projectId = env.FIREBASE_PROJECT_ID;
    
    // Use Firebase Auth REST API to get user info
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${projectId}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ localId: uid }),
      }
    );

    if (!res.ok) {
      // FAIL CLOSED: If check fails due to upstream API error, deny access
      console.error(`Revocation check failed for ${uid}: HTTP ${res.status}`);
      throw new UnauthorizedError('Authentication verification service unavailable. Please retry.');
    }

    const data = await res.json() as { users?: Array<{ disabled?: boolean; validSince?: string }> };
    const user = data.users?.[0];
    if (!user) {
      throw new UnauthorizedError('User does not exist or has been deleted');
    }

    const disabled = user.disabled === true;
    const validSinceSec = user.validSince ? parseInt(user.validSince, 10) : undefined;

    revocationCache.set(uid, {
      disabled,
      validSince: validSinceSec,
      expiresAt: now + REVOCATION_CACHE_TTL,
    });

    if (disabled) {
      throw new UnauthorizedError('Account has been disabled. Please contact support.');
    }

    if (validSinceSec && authTime && authTime < validSinceSec) {
      throw new UnauthorizedError('User session has been revoked. Please sign in again.');
    }
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      throw e;
    }
    console.error(`Revocation check error for ${uid}:`, e);
    // FAIL CLOSED on network/unexpected error
    throw new UnauthorizedError('Authentication verification temporarily unavailable. Please retry.');
  }
}

export async function verifyFirebaseIdToken(
  token: string,
  expectedProjectId: string,
  env?: Env // Optional env for revocation check
): Promise<FirebaseTokenPayload> {
  if (!token || typeof token !== 'string') {
    throw new UnauthorizedError('Missing or empty authorization token');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new UnauthorizedError('Malformed JWT structure');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg: string; kid: string };
  let payload: Record<string, unknown>;

  try {
    header = parseJwtSection<{ alg: string; kid: string }>(headerB64);
    payload = parseJwtSection<Record<string, unknown>>(payloadB64);
  } catch {
    throw new UnauthorizedError('Failed to parse JWT header or payload');
  }

  if (header.alg !== 'RS256' || !header.kid) {
    throw new UnauthorizedError('Invalid JWT header algorithm or missing key ID');
  }

  // Audience & Issuer validation
  const expectedIssuer = `https://securetoken.google.com/${expectedProjectId}`;
  if (payload.iss !== expectedIssuer) {
    throw new UnauthorizedError(`Invalid token issuer: expected ${expectedIssuer}`);
  }

  if (payload.aud !== expectedProjectId) {
    throw new UnauthorizedError(`Invalid token audience: expected ${expectedProjectId}`);
  }

  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new UnauthorizedError('Invalid token subject (missing UID)');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp);
  const iat = Number(payload.iat);

  if (isNaN(exp) || exp < nowSec) {
    throw new UnauthorizedError('Firebase ID token has expired');
  }

  // 5 minutes clock skew tolerance
  if (isNaN(iat) || iat > nowSec + 300) {
    throw new UnauthorizedError('Token issued in the future');
  }

  // Fetch matching Google JWK key
  const jwks = await getGoogleJwks();
  const matchingJwk = jwks.find((k) => k.kid === header.kid);
  if (!matchingJwk) {
    throw new UnauthorizedError('No matching public key found for token key ID');
  }

  const cryptoKey = await getCryptoKey(matchingJwk);
  const dataToVerify = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signatureBytes = base64UrlDecode(signatureB64);

  const isValid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    cryptoKey,
    signatureBytes,
    dataToVerify
  );

  if (!isValid) {
    throw new UnauthorizedError('Cryptographic signature verification failed');
  }

  // Check token revocation / account disabled (if env provided)
  if (env) {
    const uid = payload.sub as string;
    const authTime = Number(payload.auth_time || iat);
    await checkUserRevocation(env, uid, authTime);
  }

  return {
    ...payload,
    uid: payload.sub as string,
    email: payload.email as string | undefined,
    name: payload.name as string | undefined,
    iss: payload.iss as string,
    aud: payload.aud as string,
    sub: payload.sub as string,
    iat,
    exp,
    auth_time: Number(payload.auth_time || iat),
  };
}

