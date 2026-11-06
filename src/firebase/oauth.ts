import { Env } from '../config';
import { AppError } from '../utils/errors';

let cachedAccessToken: { token: string; expiresAt: number } | null = null;
let cachedPrivateKey: CryptoKey | null = null;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function stringToBase64Url(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

function pemToBinary(pem: string): Uint8Array {
  const cleanPem = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');

  const binaryString = atob(cleanPem);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function getPrivateKey(pem: string): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;

  try {
    const der = pemToBinary(pem);
    cachedPrivateKey = await crypto.subtle.importKey(
      'pkcs8',
      der,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );
    return cachedPrivateKey;
  } catch (err) {
    throw new AppError(
      `Failed to parse service-account private key: ${err instanceof Error ? err.message : String(err)}`,
      500,
      'INVALID_CREDENTIALS'
    );
  }
}

export async function getGoogleOAuthToken(
  env: Env,
  scopes = [
    'https://www.googleapis.com/auth/datastore',
    'https://www.googleapis.com/auth/firebase.messaging',
  ]
): Promise<string> {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessToken.expiresAt > now + 60000) {
    return cachedAccessToken.token;
  }

  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    throw new AppError(
      'Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY environment variables.',
      500,
      'CONFIGURATION_ERROR'
    );
  }

  const nowSec = Math.floor(now / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: nowSec + 3600,
    iat: nowSec,
  };

  const headerB64 = stringToBase64Url(JSON.stringify(header));
  const payloadB64 = stringToBase64Url(JSON.stringify(payload));
  const dataToSign = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const privateKey = await getPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, dataToSign)
  );
  const signatureB64 = base64UrlEncode(signatureBytes);

  const assertion = `${headerB64}.${payloadB64}.${signatureB64}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!tokenRes.ok) {
    const errorBody = await tokenRes.text();
    console.error('Google OAuth token error response:', errorBody);
    throw new AppError('Failed to obtain Google OAuth access token', 500, 'OAUTH_FAILED');
  }

  const tokenData = (await tokenRes.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = {
    token: tokenData.access_token,
    expiresAt: now + (tokenData.expires_in - 120) * 1000,
  };

  return cachedAccessToken.token;
}

