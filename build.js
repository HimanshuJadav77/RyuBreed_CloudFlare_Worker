// Node build script to generate a single-file standalone worker.js
// suitable for direct pasting into the Cloudflare Dashboard online Quick Editor.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Standalone self-contained worker bundle
const workerSource = `
// ============================================================================
// RyuBreed Academia — Authoritative Subscription Management System
// Cloudflare Worker API & Webhook Handler (Standalone Zero-Wrangler Deployment)
// ============================================================================

const SUBSCRIPTION_PLANS = [
  {
    id: 'core99',
    name: 'Core Plan',
    priceINR: 99,
    annualPriceINR: 948,
    durationDays: 30,
    features: [
      'Up to 150 Students',
      'Up to 10 Batches',
      'Up to 5 Staff Members',
      'Attendance & Fee Tracking',
      'Cloud Sync & Multi-Device Access',
      'Basic PDF Receipts'
    ]
  },
  {
    id: 'smart199',
    name: 'Smart Plan',
    priceINR: 199,
    annualPriceINR: 1908,
    durationDays: 30,
    features: [
      'Unlimited Students, Batches & Staff',
      'Full Academics Hub (Homework & Tests)',
      'Study Materials & Lesson Plans',
      'Automated WhatsApp Reports & Queue',
      'Graphical Performance PDF Reports',
      'Student ID Cards & Merit Certificates'
    ]
  }
];

const DEFAULT_TRIAL_DAYS = 7;

// --- Utilities ---
class AppError extends Error {
  constructor(message, statusCode = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden: Access denied') {
    super(message, 403, 'FORBIDDEN');
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflict detected') {
    super(message, 409, 'CONFLICT');
  }
}

function nowUtc() {
  return new Date();
}

function nowIso() {
  return new Date().toISOString();
}

function addDays(date, days) {
  return new Date(date.getTime() + Math.round(days * 86400000));
}

function isPast(date) {
  return date.getTime() <= Date.now();
}

function remainingDays(expiryDate) {
  const diffMs = expiryDate.getTime() - Date.now();
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

function assertRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('Missing or invalid required field: ' + fieldName, 400, 'INVALID_INPUT');
  }
  return value.trim();
}

function assertRequiredNumber(value, fieldName, min = 0) {
  if (typeof value !== 'number' || isNaN(value) || value < min) {
    throw new AppError('Field ' + fieldName + ' must be a number >= ' + min, 400, 'INVALID_INPUT');
  }
  return value;
}

async function parseJsonBody(request, maxBytes = 1024 * 1024) {
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new AppError('Request payload exceeds 1MB limit', 413, 'PAYLOAD_TOO_LARGE');
  }

  if (!request.body) return {};

  if (typeof request.body.getReader !== 'function') {
    return await request.json().catch(() => ({}));
  }

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.length;
        if (totalBytes > maxBytes) {
          throw new AppError('Request payload exceeds 1MB limit', 413, 'PAYLOAD_TOO_LARGE');
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) return {};

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  const text = new TextDecoder('utf-8').decode(merged);
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Malformed JSON payload', 400, 'BAD_REQUEST');
  }
}

function resolveCorsOrigin(request, allowedOriginsConfig) {
  const requestOrigin = request.headers.get('Origin');
  if (!requestOrigin) {
    return { isAllowed: true, allowOriginHeader: null };
  }
  const rawConfig = (allowedOriginsConfig || '').trim();
  const configured = rawConfig.split(',').map((o) => o.trim().toLowerCase()).filter(Boolean);
  if (configured.includes('*')) {
    return { isAllowed: true, allowOriginHeader: requestOrigin };
  }
  if (configured.includes(requestOrigin.toLowerCase())) {
    return { isAllowed: true, allowOriginHeader: requestOrigin };
  }
  return { isAllowed: false, allowOriginHeader: null };
}

function jsonResponse(data, status = 200, allowOriginHeader = null) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY'
  };
  if (allowOriginHeader) {
    headers['Access-Control-Allow-Origin'] = allowOriginHeader;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With, X-Admin-Api-Key';
    headers['Vary'] = 'Origin';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(error, allowOriginHeader = null) {
  let status = 500;
  let message = 'Internal Server Error';
  let code = 'INTERNAL_ERROR';

  if (error && typeof error === 'object' && 'statusCode' in error) {
    status = error.statusCode || 400;
    message = error.message || 'Error occurred';
    code = error.code || 'BAD_REQUEST';
  } else if (error instanceof Error) {
    message = error.message;
  }

  if (status >= 500) {
    console.error('Unhandled internal exception:', error);
    message = 'An unexpected server error occurred. Please contact support.';
  }

  return jsonResponse({ success: false, error: { code, message } }, status, allowOriginHeader);
}

function handleCors(request, allowedOriginsConfig) {
  const { isAllowed, allowOriginHeader } = resolveCorsOrigin(request, allowedOriginsConfig);
  if (!isAllowed) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'CORS origin not allowed' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Admin-Api-Key',
    'Access-Control-Max-Age': '86400',
  };
  if (allowOriginHeader) {
    headers['Access-Control-Allow-Origin'] = allowOriginHeader;
    headers['Vary'] = 'Origin';
  }
  return new Response(null, { status: 204, headers });
}

// --- Firebase Token Verification (Web Crypto) ---
let cachedJwks = null;
const cryptoKeyCache = new Map();

function base64UrlDecode(str) {
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

function parseJwtSection(section) {
  const bytes = base64UrlDecode(section);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

async function getGoogleJwks() {
  const now = Date.now();
  if (cachedJwks && cachedJwks.expiresAt > now) {
    return cachedJwks.keys;
  }

  const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  if (!res.ok) {
    throw new UnauthorizedError('Failed to fetch Google public verification keys');
  }

  const cacheControl = res.headers.get('cache-control');
  let maxAge = 3600;
  if (cacheControl) {
    const match = cacheControl.match(/max-age=(\\\\d+)/);
    if (match) maxAge = parseInt(match[1], 10);
  }

  const data = await res.json();
  cachedJwks = { keys: data.keys, expiresAt: now + maxAge * 1000 };
  cryptoKeyCache.clear();
  return data.keys;
}

async function getCryptoKey(jwk) {
  const cached = cryptoKeyCache.get(jwk.kid);
  if (cached) return cached;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, alg: jwk.alg, use: jwk.use, kid: jwk.kid, n: jwk.n, e: jwk.e },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  cryptoKeyCache.set(jwk.kid, key);
  return key;
}

const revocationCache = new Map();
const REVOCATION_CACHE_TTL = 5 * 60 * 1000;

async function checkUserRevocation(env, uid, authTime) {
  if (!env || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    const isTestEnv = env && (env.ENVIRONMENT === 'test' || env.SKIP_REVOCATION_CHECK === true || env.SKIP_REVOCATION_CHECK === 'true');
    if (isTestEnv) return;
    throw new UnauthorizedError('Authentication verification service misconfigured in production: missing service account credentials');
  }
  const now = Date.now();
  const cached = revocationCache.get(uid);
  if (cached && cached.expiresAt > now) {
    if (cached.disabled) throw new UnauthorizedError('Account has been disabled. Please contact support.');
    if (cached.validSince && authTime && authTime < cached.validSince) throw new UnauthorizedError('User session has been revoked. Please sign in again.');
    return;
  }
  try {
    const accessToken = await getGoogleOAuthToken(env);
    const projectId = env.FIREBASE_PROJECT_ID;
    const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + projectId, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ localId: uid })
    });
    if (!res.ok) {
      console.error('Revocation check failed for ' + uid + ': HTTP ' + res.status);
      throw new UnauthorizedError('Authentication verification service unavailable. Please retry.');
    }
    const data = await res.json();
    const user = data.users?.[0];
    if (!user) throw new UnauthorizedError('User does not exist or has been deleted');
    const disabled = user.disabled === true;
    const validSinceSec = user.validSince ? parseInt(user.validSince, 10) : undefined;
    revocationCache.set(uid, { disabled, validSince: validSinceSec, expiresAt: now + REVOCATION_CACHE_TTL });
    if (disabled) throw new UnauthorizedError('Account has been disabled. Please contact support.');
    if (validSinceSec && authTime && authTime < validSinceSec) throw new UnauthorizedError('User session has been revoked. Please sign in again.');
  } catch (e) {
    if (e instanceof UnauthorizedError) throw e;
    console.error('Revocation check error for ' + uid + ':', e);
    throw new UnauthorizedError('Authentication verification temporarily unavailable. Please retry.');
  }
}

async function verifyFirebaseIdToken(token, expectedProjectId, env) {
  if (!token || typeof token !== 'string') {
    throw new UnauthorizedError('Missing or empty authorization token');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new UnauthorizedError('Malformed JWT structure');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  let header, payload;
  try {
    header = parseJwtSection(headerB64);
    payload = parseJwtSection(payloadB64);
  } catch (_) {
    throw new UnauthorizedError('Failed to parse JWT header or payload');
  }

  if (header.alg !== 'RS256' || !header.kid) {
    throw new UnauthorizedError('Invalid JWT header algorithm or missing key ID');
  }

  const expectedIssuer = 'https://securetoken.google.com/' + expectedProjectId;
  if (payload.iss !== expectedIssuer) {
    throw new UnauthorizedError('Invalid token issuer: expected ' + expectedIssuer);
  }
  if (payload.aud !== expectedProjectId) {
    throw new UnauthorizedError('Invalid token audience: expected ' + expectedProjectId);
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
  if (isNaN(iat) || iat > nowSec + 300) {
    throw new UnauthorizedError('Token issued in the future');
  }

  const jwks = await getGoogleJwks();
  const matchingJwk = jwks.find((k) => k.kid === header.kid);
  if (!matchingJwk) {
    throw new UnauthorizedError('No matching public key found for token key ID');
  }

  const cryptoKey = await getCryptoKey(matchingJwk);
  const dataToVerify = new TextEncoder().encode(headerB64 + '.' + payloadB64);
  const signatureBytes = base64UrlDecode(signatureB64);

  const isValid = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, cryptoKey, signatureBytes, dataToVerify);
  if (!isValid) {
    throw new UnauthorizedError('Cryptographic signature verification failed');
  }

  if (env) {
    const authTime = Number(payload.auth_time || iat);
    await checkUserRevocation(env, payload.sub, authTime);
  }

  return {
    ...payload,
    uid: payload.sub,
    email: payload.email,
    name: payload.name,
    iss: payload.iss,
    aud: payload.aud,
    sub: payload.sub,
    iat,
    exp,
    auth_time: Number(payload.auth_time || iat),
  };
}

// --- Google OAuth2 Service Account Assertion (Web Crypto) ---
let cachedAccessToken = null;
let cachedPrivateKey = null;

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function stringToBase64Url(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

function pemToBinary(pem) {
  const cleanPem = pem
    .replaceAll('-----BEGIN PRIVATE KEY-----', '')
    .replaceAll('-----END PRIVATE KEY-----', '')
    .replaceAll('\\\\n', '')
    .replaceAll('\\n', '')
    .replaceAll('\\r', '')
    .replaceAll(' ', '')
    .trim();
  const binaryString = atob(cleanPem);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function getPrivateKey(pem) {
  if (cachedPrivateKey) return cachedPrivateKey;
  try {
    const der = pemToBinary(pem);
    cachedPrivateKey = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return cachedPrivateKey;
  } catch (err) {
    throw new AppError('Failed to parse service-account private key: ' + err.message, 500, 'INVALID_CREDENTIALS');
  }
}

async function getGoogleOAuthToken(env, scopes = ['https://www.googleapis.com/auth/datastore', 'https://www.googleapis.com/auth/firebase.messaging']) {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessToken.expiresAt > now + 60000) {
    return cachedAccessToken.token;
  }

  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    throw new AppError('Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY environment variables.', 500, 'CONFIGURATION_ERROR');
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
  const dataToSign = new TextEncoder().encode(headerB64 + '.' + payloadB64);

  const privateKey = await getPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const signatureBytes = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, dataToSign));
  const signatureB64 = base64UrlEncode(signatureBytes);
  const assertion = headerB64 + '.' + payloadB64 + '.' + signatureB64;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });

  if (!tokenRes.ok) {
    const errorBody = await tokenRes.text();
    console.error('Google OAuth token error response:', errorBody);
    throw new AppError('Failed to obtain Google OAuth access token', 500, 'OAUTH_FAILED');
  }

  const tokenData = await tokenRes.json();
  cachedAccessToken = { token: tokenData.access_token, expiresAt: now + (tokenData.expires_in - 120) * 1000 };
  return cachedAccessToken.token;
}

// --- Firestore REST Client ---
function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: val.toString() };
    return { doubleValue: val };
  }
  if (typeof val === 'string') {
    if (/^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}/.test(val)) return { timestampValue: val };
    return { stringValue: val };
  }
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreValue(val) {
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return val.doubleValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('timestampValue' in val) return val.timestampValue;
  if ('nullValue' in val) return null;
  if ('mapValue' in val) {
    const res = {};
    const fields = val.mapValue.fields || {};
    for (const [k, v] of Object.entries(fields)) res[k] = fromFirestoreValue(v);
    return res;
  }
  if ('arrayValue' in val) {
    const values = val.arrayValue.values || [];
    return values.map(fromFirestoreValue);
  }
  return null;
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) fields[k] = toFirestoreValue(v);
  }
  return fields;
}

function fromFirestoreDoc(doc) {
  const res = {};
  if (doc.name) {
    res._id = doc.name.split('/').pop();
    res._path = doc.name;
  }
  const fields = doc.fields || {};
  for (const [k, v] of Object.entries(fields)) res[k] = fromFirestoreValue(v);
  return res;
}

class FirestoreClient {
  constructor(env) {
    this.env = env;
    this.baseUrl = 'https://firestore.googleapis.com/v1/projects/' + env.FIREBASE_PROJECT_ID + '/databases/(default)/documents';
  }

  async fetchAuth(url, init) {
    const token = await getGoogleOAuthToken(this.env);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', 'Bearer ' + token);
    headers.set('Content-Type', 'application/json');
    return fetch(url, { ...init, headers });
  }

  async checkHealth() {
    const start = Date.now();
    try {
      if (
        this.env.SKIP_REVOCATION_CHECK === 'true' ||
        this.env.ENVIRONMENT === 'test' ||
        this.env.FIREBASE_PROJECT_ID === 'test-project-id' ||
        (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test')
      ) {
        return { healthy: true, latencyMs: 0 };
      }
      const url = this.baseUrl + '/institutes?pageSize=1';
      const res = await this.fetchAuth(url);
      const latencyMs = Date.now() - start;
      if (res.ok) return { healthy: true, latencyMs };
      return { healthy: false, latencyMs, error: 'Firestore status ' + res.status };
    } catch (e) {
      return { healthy: false, latencyMs: Date.now() - start, error: e?.message || String(e) };
    }
  }

  async getDocument(path) {
    const url = this.baseUrl + '/' + path;
    const res = await this.fetchAuth(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      const errText = await res.text();
      throw new AppError('Firestore getDoc error (' + res.status + '): ' + errText, res.status, 'FIRESTORE_ERROR');
    }
    const doc = await res.json();
    return fromFirestoreDoc(doc);
  }

  async setDocument(path, data, merge = true) {
    const fields = toFirestoreFields(data);
    const queryParams = new URLSearchParams();
    if (merge) {
      for (const key of Object.keys(data)) queryParams.append('updateMask.fieldPaths', key);
    }
    const queryString = queryParams.toString() ? '?' + queryParams.toString() : '';
    const url = this.baseUrl + '/' + path + queryString;

    const res = await this.fetchAuth(url, { method: 'PATCH', body: JSON.stringify({ fields }) });
    if (!res.ok) {
      const errText = await res.text();
      throw new AppError('Firestore setDoc error (' + res.status + '): ' + errText, res.status, 'FIRESTORE_ERROR');
    }
    const result = await res.json();
    return fromFirestoreDoc(result);
  }

  async createDocument(parentPath, collectionId, data, documentId) {
    const fields = toFirestoreFields(data);
    const queryParams = new URLSearchParams();
    if (documentId) queryParams.set('documentId', documentId);
    const queryString = queryParams.toString() ? '?' + queryParams.toString() : '';
    const parentUrl = parentPath ? this.baseUrl + '/' + parentPath + '/' + collectionId + queryString : this.baseUrl + '/' + collectionId + queryString;

    const res = await this.fetchAuth(parentUrl, { method: 'POST', body: JSON.stringify({ fields }) });
    if (!res.ok) {
      const errText = await res.text();
      throw new AppError('Firestore createDoc error (' + res.status + '): ' + errText, res.status, 'FIRESTORE_ERROR');
    }
    const result = await res.json();
    return fromFirestoreDoc(result);
  }

  async runQuery(collectionId, filters, limit = 100) {
    const url = 'https://firestore.googleapis.com/v1/projects/' + this.env.FIREBASE_PROJECT_ID + '/databases/(default)/documents:runQuery';
    const structuredQuery = { from: [{ collectionId }], limit };

    if (filters && filters.length > 0) {
      if (filters.length === 1) {
        structuredQuery.where = {
          fieldFilter: { field: { fieldPath: filters[0].field }, op: filters[0].op, value: toFirestoreValue(filters[0].value) }
        };
      } else {
        structuredQuery.where = {
          compositeFilter: {
            op: 'AND',
            filters: filters.map((f) => ({ fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: toFirestoreValue(f.value) } }))
          }
        };
      }
    }

    const res = await this.fetchAuth(url, { method: 'POST', body: JSON.stringify({ structuredQuery }) });
    if (!res.ok) {
      const errText = await res.text();
      throw new AppError('Firestore runQuery error (' + res.status + '): ' + errText, res.status, 'FIRESTORE_ERROR');
    }
    const items = await res.json();
    const results = [];
    for (const item of items) {
      if (item.document) results.push(fromFirestoreDoc(item.document));
    }
    return results;
  }

  async commitBatchWrites(writes) {
    const url = 'https://firestore.googleapis.com/v1/projects/' + this.env.FIREBASE_PROJECT_ID + '/databases/(default)/documents:commit';
    const formattedWrites = writes.map((w) => {
      if (w.update) {
        const fullDocName = w.update.name.startsWith('projects/')
          ? w.update.name
          : 'projects/' + this.env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/' + w.update.name;
        const fields = toFirestoreFields(w.update.fields);
        const updateObj = { update: { name: fullDocName, fields } };
        if (w.update.updateMask) {
          updateObj.updateMask = { fieldPaths: w.update.updateMask };
        }
        if (w.currentDocument) {
          updateObj.currentDocument = w.currentDocument;
        }
        return updateObj;
      }
      if (w.delete) {
        const fullDocName = w.delete.startsWith('projects/')
          ? w.delete
          : 'projects/' + this.env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/' + w.delete;
        const deleteObj = { delete: fullDocName };
        if (w.currentDocument) {
          deleteObj.currentDocument = w.currentDocument;
        }
        return deleteObj;
      }
      return {};
    });

    const res = await this.fetchAuth(url, { method: 'POST', body: JSON.stringify({ writes: formattedWrites }) });
    if (!res.ok) {
      const errText = await res.text();
      throw new AppError('Firestore commit error (' + res.status + '): ' + errText, res.status, 'FIRESTORE_ERROR');
    }
  }
}

// --- FCM Notifications ---
async function sendFcmNotification(env, payload) {
  if (!payload.token || payload.token.trim().length === 0) return false;
  try {
    const accessToken = await getGoogleOAuthToken(env);
    const url = 'https://fcm.googleapis.com/v1/projects/' + env.FIREBASE_PROJECT_ID + '/messages:send';
    const message = {
      message: {
        token: payload.token,
        notification: { title: payload.title, body: payload.body },
        data: payload.data || {},
        android: { priority: 'high', notification: { channel_id: 'subscription_alerts', sound: 'default' } },
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    return res.ok;
  } catch (err) {
    console.error('FCM send exception:', err);
    return false;
  }
}

// --- Admin Verification ---
async function verifyAdminUser(uid, env, firestore) {
  if (!uid) throw new ForbiddenError('Unauthorized: Missing user UID');
  if (env.ADMIN_BOOTSTRAP_UID && env.ADMIN_BOOTSTRAP_UID.trim() === uid.trim()) return true;

  const adminDoc = await firestore.getDocument('admin_users/' + uid);
  if (adminDoc && adminDoc.active === true && adminDoc.role === 'admin') return true;

  throw new ForbiddenError('Administrator permissions required for this operation');
}

// --- Subscription Domain Services ---
class SubscriptionService {
  constructor(firestore) {
    this.firestore = firestore;
  }

  async getSubscriptionStatus(instituteId) {
    const institute = await this.firestore.getDocument('institutes/' + instituteId);
    if (!institute) throw new NotFoundError('Institute with ID ' + instituteId + ' not found');

    const trialUsed = institute.trialUsed === true;
    let status = institute.subscriptionStatus || 'expired';
    let planId = institute.planTier || 'core99';
    let startAt = null;
    let endAt = null;
    let licenseKey = institute.licenseKey || null;

    if (institute.activeSubscriptionId) {
      const sub = await this.firestore.getDocument('subscriptions/' + institute.activeSubscriptionId);
      if (sub) {
        planId = sub.planId || planId;
        status = sub.status || status;
        startAt = sub.startAt || null;
        endAt = sub.endAt || null;
        licenseKey = sub.licenseKey || licenseKey;
      }
    } else if (status === 'trial' || (!trialUsed && !institute.subscriptionStatus)) {
      startAt = institute.trialStartedAt || null;
      endAt = institute.trialEndsAt || null;
      planId = 'smart199';
    }

    let remaining = 0;
    let isValid = false;
    if (endAt) {
      const expiryDate = new Date(endAt);
      remaining = remainingDays(expiryDate);
      if (isPast(expiryDate)) {
        if (status === 'trial' || status === 'active') {
          status = 'expired';
          await this.firestore.setDocument('institutes/' + instituteId, { subscriptionStatus: 'expired', updatedAt: nowIso() });
          await this.firestore.setDocument('institutes/' + instituteId + '/license/current', { status: 'expired', updatedAt: nowIso() });
          if (institute.activeSubscriptionId) {
            await this.firestore.setDocument('subscriptions/' + institute.activeSubscriptionId, { status: 'expired', updatedAt: nowIso() });
          }
        }
        isValid = false;
        remaining = 0;
      } else if (status === 'trial' || status === 'active') {
        isValid = true;
      }
    } else {
      if (status !== 'revoked') status = 'expired';
      isValid = false;
      remaining = 0;
    }

    if (status === 'revoked') {
      isValid = false;
      remaining = 0;
    }

    const matchedPlan = SUBSCRIPTION_PLANS.find((p) => p.id === planId) || SUBSCRIPTION_PLANS[0];
    const planName = status === 'trial' ? '7-Day Free Trial (Smart)' : matchedPlan.name;

    return {
      instituteId,
      instituteName: institute.name || 'RyuBreed Institute',
      planId,
      planName,
      status,
      isTrial: status === 'trial',
      isValid,
      startAt,
      endAt,
      remainingDays: remaining,
      trialEligible: !trialUsed,
      trialUsed,
      licenseKey,
      features: matchedPlan.features,
      serverTimestamp: Date.now(),
    };
  }
}

class TrialService {
  constructor(firestore) {
    this.firestore = firestore;
  }

  async startAutomaticTrial(instituteId, userUid) {
    const institute = await this.firestore.getDocument('institutes/' + instituteId);
    if (!institute) throw new NotFoundError('Institute ' + instituteId + ' not found');

    const ownerUid = institute.ownerUid || institute.id;
    if (ownerUid && ownerUid !== userUid && instituteId !== userUid) {
      throw new ForbiddenError('You are not authorized to activate a trial for this institute');
    }
    if (institute.subscriptionStatus === 'active') {
      throw new ConflictError('Institute already has an active paid subscription');
    }

    if (institute.trialUsed === true) {
      if (institute.trialEndsAt && new Date(institute.trialEndsAt).getTime() > Date.now()) {
        return {
          success: true,
          instituteId,
          trialEndsAt: institute.trialEndsAt,
          durationDays: DEFAULT_TRIAL_DAYS,
          licenseKey: institute.licenseKey || ('LIC-TRIAL-' + instituteId.substring(0, 8).toUpperCase()),
          status: 'trial',
          isExisting: true,
        };
      }
      throw new ConflictError('Trial has already been consumed for this institute');
    }

    const existingTrialDoc = await this.firestore.getDocument('subscription_trials/' + instituteId);
    if (existingTrialDoc) {
      if (existingTrialDoc.endAt && new Date(existingTrialDoc.endAt).getTime() > Date.now()) {
        return {
          success: true,
          instituteId,
          trialEndsAt: existingTrialDoc.endAt,
          durationDays: DEFAULT_TRIAL_DAYS,
          licenseKey: existingTrialDoc.licenseKey || institute.licenseKey || ('LIC-TRIAL-' + instituteId.substring(0, 8).toUpperCase()),
          status: 'trial',
          isExisting: true,
        };
      }
      throw new ConflictError('Trial has already been consumed for this institute');
    }

    const startAt = nowUtc();
    const endAt = addDays(startAt, DEFAULT_TRIAL_DAYS);
    const licenseKey = 'LIC-TRIAL-' + instituteId.substring(0, 8).toUpperCase() + '-' + Date.now().toString().slice(-4);

    try {
      await this.firestore.commitBatchWrites([
        {
          currentDocument: { exists: false },
          update: {
            name: 'subscription_trials/' + instituteId,
            fields: {
              trialId: 'trial_' + instituteId,
              instituteId,
              durationDays: DEFAULT_TRIAL_DAYS,
              startAt: startAt.toISOString(),
              endAt: endAt.toISOString(),
              licenseKey,
              grantedBy: 'system_automatic',
              reason: 'Initial 7-day institute registration trial',
              createdAt: nowIso(),
            },
          },
        },
        {
          update: {
            name: 'institutes/' + instituteId,
            fields: {
              trialUsed: true,
              trialStartedAt: startAt.toISOString(),
              trialEndsAt: endAt.toISOString(),
              subscriptionStatus: 'trial',
              planTier: 'smart199',
              licenseKey,
              updatedAt: nowIso(),
            },
            updateMask: ['trialUsed', 'trialStartedAt', 'trialEndsAt', 'subscriptionStatus', 'planTier', 'licenseKey', 'updatedAt'],
          },
        },
        {
          update: {
            name: 'institutes/' + instituteId + '/license/current',
            fields: {
              licenseKey,
              planId: 'smart199',
              status: 'active',
              isTrial: true,
              activatedAt: startAt.toISOString(),
              validUntil: endAt.toISOString(),
              updatedAt: nowIso(),
            },
            updateMask: ['licenseKey', 'planId', 'status', 'isTrial', 'activatedAt', 'validUntil', 'updatedAt'],
          },
        },
        {
          update: {
            name: 'subscription_audit_logs/trial_' + instituteId + '_' + startAt.getTime(),
            fields: {
              action: 'TRIAL_STARTED_AUTOMATIC',
              instituteId,
              performedBy: userUid,
              oldValue: institute.subscriptionStatus || 'none',
              newValue: 'trial',
              reason: '7-day automated trial activation',
              timestamp: nowIso(),
            },
          },
        },
      ]);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('already exists') || errMsg.includes('ALREADY_EXISTS') || errMsg.includes('FAILED_PRECONDITION')) {
        const createdTrial = await this.firestore.getDocument('subscription_trials/' + instituteId);
        if (createdTrial?.endAt && new Date(createdTrial.endAt).getTime() > Date.now()) {
          return {
            success: true,
            instituteId,
            trialEndsAt: createdTrial.endAt,
            durationDays: DEFAULT_TRIAL_DAYS,
            licenseKey: createdTrial.licenseKey || licenseKey,
            status: 'trial',
            isExisting: true,
          };
        }
        throw new ConflictError('Trial has already been consumed for this institute');
      }
      throw err;
    }

    return { success: true, instituteId, trialEndsAt: endAt.toISOString(), durationDays: DEFAULT_TRIAL_DAYS, licenseKey, status: 'trial' };
  }

  async grantAdminTrial(instituteId, durationDays, reason, adminUid) {
    if (durationDays <= 0 || durationDays > 365) throw new AppError('Trial duration must be between 1 and 365 days', 400);
    const institute = await this.firestore.getDocument('institutes/' + instituteId);
    if (!institute) throw new NotFoundError('Institute ' + instituteId + ' not found');

    const startAt = nowUtc();
    const endAt = addDays(startAt, durationDays);
    const trialId = 'admin_trial_' + instituteId + '_' + Date.now();
    const licenseKey = 'LIC-ADMIN-' + instituteId.substring(0, 8).toUpperCase() + '-' + Date.now().toString().slice(-4);

    await this.firestore.commitBatchWrites([
      {
        update: {
          name: 'subscription_trials/' + trialId,
          fields: {
            trialId, instituteId, durationDays, startAt: startAt.toISOString(), endAt: endAt.toISOString(),
            grantedBy: adminUid, reason: reason || 'Admin trial grant', createdAt: nowIso()
          }
        }
      },
      {
        update: {
          name: 'institutes/' + instituteId,
          fields: {
            trialStartedAt: startAt.toISOString(), trialEndsAt: endAt.toISOString(),
            subscriptionStatus: 'trial', planTier: 'smart199', licenseKey, updatedAt: nowIso()
          },
          updateMask: ['trialStartedAt', 'trialEndsAt', 'subscriptionStatus', 'planTier', 'licenseKey', 'updatedAt']
        }
      },
      {
        update: {
          name: 'institutes/' + instituteId + '/license/current',
          fields: {
            licenseKey, planId: 'smart199', status: 'active', isTrial: true,
            activatedAt: startAt.toISOString(), validUntil: endAt.toISOString(), updatedAt: nowIso()
          },
          updateMask: ['licenseKey', 'planId', 'status', 'isTrial', 'activatedAt', 'validUntil', 'updatedAt']
        }
      },
      {
        update: {
          name: 'subscription_audit_logs/log_' + Date.now(),
          fields: {
            action: 'ADMIN_TRIAL_GRANTED', instituteId, performedBy: adminUid,
            oldValue: institute.subscriptionStatus || 'unknown', newValue: 'trial_' + durationDays + 'd',
            reason: reason || 'Administrative trial grant', timestamp: nowIso()
          }
        }
      }
    ]);

    return { success: true, instituteId, trialEndsAt: endAt.toISOString(), durationDays, licenseKey, status: 'trial' };
  }

  async revokeSubscription(instituteId, reason, adminUid) {
    const institute = await this.firestore.getDocument('institutes/' + instituteId);
    if (!institute) throw new NotFoundError('Institute ' + instituteId + ' not found');

    await this.firestore.commitBatchWrites([
      {
        update: {
          name: 'institutes/' + instituteId,
          fields: { subscriptionStatus: 'revoked', updatedAt: nowIso() },
          updateMask: ['subscriptionStatus', 'updatedAt']
        }
      },
      {
        update: {
          name: 'institutes/' + instituteId + '/license/current',
          fields: { status: 'revoked', validUntil: nowIso(), updatedAt: nowIso() },
          updateMask: ['status', 'validUntil', 'updatedAt']
        }
      },
      {
        update: {
          name: 'subscription_audit_logs/log_' + Date.now(),
          fields: {
            action: 'ADMIN_SUBSCRIPTION_REVOKED', instituteId, performedBy: adminUid,
            oldValue: institute.subscriptionStatus || 'unknown', newValue: 'revoked',
            reason: reason || 'Administrative revocation', timestamp: nowIso()
          }
        }
      }
    ]);

    return { success: true, instituteId, status: 'revoked', message: 'Subscription or trial successfully revoked' };
  }
}

class PaymentService {
  constructor(env, firestore) {
    this.env = env;
    this.firestore = firestore;
  }

  isConfigured() {
    return Boolean(
      this.env.RAZORPAY_KEY_ID &&
      this.env.RAZORPAY_KEY_SECRET &&
      this.env.RAZORPAY_KEY_ID.trim().length > 0 &&
      this.env.RAZORPAY_KEY_SECRET.trim().length > 0
    );
  }

  async getActivePlans() {
    try {
      const doc = await this.firestore.getDocument('system_config/plans');
      if (doc && Array.isArray(doc.plans) && doc.plans.length > 0) {
        return doc.plans;
      }
    } catch {}
    return SUBSCRIPTION_PLANS;
  }

  async createOrder(instituteId, planId, userUid, isAnnual = false) {
    const plans = await this.getActivePlans();
    const plan = plans.find((p) => p.id === planId) || SUBSCRIPTION_PLANS.find((p) => p.id === planId);
    if (!plan) throw new AppError('Invalid plan ID: ' + planId, 400);

    const effectivePriceINR = isAnnual ? (plan.annualPriceINR || plan.priceINR * 12) : plan.priceINR;

    if (!this.isConfigured()) {
      return {
        success: false,
        configured: false,
        code: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
        message: 'Razorpay payment gateway credentials (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) are not configured on the backend. Subscriptions cannot be purchased yet. Please use the 7-day trial or contact institute administration.',
        planId: plan.id,
        amountINR: effectivePriceINR,
        isAnnual: Boolean(isAnnual),
      };
    }

    const amountInPaise = effectivePriceINR * 100;
    const authHeader = btoa(this.env.RAZORPAY_KEY_ID + ':' + this.env.RAZORPAY_KEY_SECRET);

    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amountInPaise,
        currency: 'INR',
        receipt: 'rcpt_' + instituteId.substring(0, 8) + '_' + Date.now(),
        notes: { instituteId, planId: plan.id, isAnnual: String(Boolean(isAnnual)), requestedBy: userUid },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Razorpay order creation error:', err);
      throw new AppError('Failed to initialize payment order with gateway', 502);
    }

    const orderData = await res.json();
    await this.firestore.setDocument('institutes/' + instituteId + '/subscription_orders/' + orderData.id, {
      orderId: orderData.id, instituteId, planId: plan.id, amount: effectivePriceINR, isAnnual: Boolean(isAnnual), currency: 'INR', status: 'created', createdAt: nowIso(),
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
      isAnnual: Boolean(isAnnual),
    };
  }

  async verifyPayment(params) {
    const { instituteId, planId, paymentId, orderId, signature, userUid } = params;
    if (!paymentId || !orderId || !signature) {
      throw new AppError('Missing paymentId, orderId, or signature for verification', 400);
    }

    // 1. Fail safe if credentials are not configured
    if (!this.isConfigured()) {
      return {
        success: false,
        configured: false,
        code: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
        message: 'Payment verification is disabled: Razorpay credentials are not yet configured on the server. No fake activations are permitted.',
      };
    }

    // 2. Validate plan ID against valid subscription plans
    const plans = await this.getActivePlans();
    const plan = plans.find((p) => p.id === planId) || SUBSCRIPTION_PLANS.find((p) => p.id === planId);
    if (!plan) {
      throw new AppError('Invalid subscription plan specified: ' + planId, 400, 'INVALID_PLAN');
    }

    // 3. Web Crypto HMAC-SHA256 verification (MUST happen BEFORE cache lookup to prevent bypass)
    const secret = this.env.RAZORPAY_KEY_SECRET;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(orderId + '|' + paymentId));
    const expectedSignature = Array.from(new Uint8Array(signatureBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');

    if (expectedSignature.toLowerCase() !== signature.trim().toLowerCase()) {
      throw new AppError('Invalid payment signature verification failed', 400, 'INVALID_SIGNATURE');
    }

    // 4. Scoped Idempotency Check
    const rawKey = params.idempotencyKey || 'pay_' + paymentId;
    const idempotencyKey = instituteId + '_' + rawKey;
    const cachePath = 'subscription_idempotency/' + idempotencyKey;
    const cached = await this.firestore.getDocument(cachePath);

    if (cached) {
      if (
        cached.paymentId !== paymentId ||
        cached.orderId !== orderId ||
        cached.instituteId !== instituteId ||
        (cached.planId && cached.planId !== planId)
      ) {
        throw new ConflictError('Idempotency key reuse detected with mismatched payment parameters');
      }
      if (cached.result) {
        return cached.result;
      }
    }

    // 5. Look up stored order to verify plan and amount binding
    const orderDoc = await this.firestore.getDocument('institutes/' + instituteId + '/subscription_orders/' + orderId);
    const isAnnualOrder = Boolean(orderDoc?.isAnnual);
    const expectedPriceINR = isAnnualOrder ? (plan.annualPriceINR || plan.priceINR * 12) : plan.priceINR;

    if (orderDoc) {
      if (orderDoc.planId && orderDoc.planId !== planId) {
        throw new AppError('Plan mismatch: Requested plan (' + planId + ') does not match order plan (' + orderDoc.planId + ')', 400, 'PLAN_MISMATCH');
      }
      if (orderDoc.amount && Number(orderDoc.amount) !== expectedPriceINR) {
        throw new AppError('Price mismatch: Plan price does not match recorded order amount', 400, 'PRICE_MISMATCH');
      }
    }

    // 6. Concurrency-Safe Atomic Activation via Firestore Batch Write
    const startAt = nowUtc();
    const durationDays = isAnnualOrder ? 365 : (plan.durationDays || 30);
    const endAt = addDays(startAt, durationDays);
    const subscriptionId = 'sub_' + instituteId + '_' + Date.now();
    const licenseKey = 'LIC-PAID-' + plan.id.toUpperCase() + '-' + Date.now().toString().slice(-6);

    const result = {
      success: true,
      configured: true,
      subscriptionId,
      licenseKey,
      planId: plan.id,
      status: 'active',
      validUntil: endAt.toISOString(),
    };

    try {
      await this.firestore.commitBatchWrites([
        {
          currentDocument: { exists: false },
          update: {
            name: 'subscription_payments/' + paymentId,
            fields: {
              paymentId,
              instituteId,
              orderId,
              razorpayPaymentId: paymentId,
              planId: plan.id,
              amount: plan.priceINR,
              currency: 'INR',
              status: 'captured',
              verifiedAt: nowIso(),
              createdAt: nowIso(),
            },
          },
        },
        {
          update: {
            name: 'subscriptions/' + subscriptionId,
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
            name: 'institutes/' + instituteId,
            fields: {
              subscriptionStatus: 'active',
              activeSubscriptionId: subscriptionId,
              planTier: plan.id,
              licenseKey,
              updatedAt: nowIso(),
            },
            updateMask: ['subscriptionStatus', 'activeSubscriptionId', 'planTier', 'licenseKey', 'updatedAt'],
          },
        },
        {
          update: {
            name: 'institutes/' + instituteId + '/license/current',
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
            updateMask: ['licenseKey', 'planId', 'status', 'isTrial', 'paymentId', 'activatedAt', 'validUntil', 'updatedAt'],
          },
        },
        {
          update: {
            name: 'subscription_audit_logs/log_' + Date.now(),
            fields: {
              action: 'PAYMENT_VERIFIED_SUBSCRIPTION_ACTIVATED',
              instituteId,
              performedBy: userUid,
              oldValue: 'pending_or_trial',
              newValue: 'active_' + plan.id,
              reason: 'Razorpay payment verified: ' + paymentId,
              timestamp: nowIso(),
            },
          },
        },
        {
          update: {
            name: cachePath,
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
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        errMsg.includes('already exists') ||
        errMsg.includes('ALREADY_EXISTS') ||
        errMsg.includes('FAILED_PRECONDITION')
      ) {
        throw new ConflictError('Payment ' + paymentId + ' has already been processed and activated');
      }
      throw err;
    }

    return result;
  }

  async processWebhook(rawBody, signatureHeader) {
    const webhookSecret = this.env.RAZORPAY_WEBHOOK_SECRET || this.env.RAZORPAY_KEY_SECRET;
    if (!webhookSecret) {
      throw new AppError('Razorpay webhook secret is not configured on the server', 503);
    }
    if (!signatureHeader) {
      throw new AppError('Missing X-Razorpay-Signature header', 400);
    }

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
    const expectedSignature = Array.from(new Uint8Array(signatureBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');

    if (expectedSignature.toLowerCase() !== signatureHeader.trim().toLowerCase()) {
      throw new AppError('Invalid webhook signature verification failed', 400, 'INVALID_WEBHOOK_SIGNATURE');
    }

    const event = JSON.parse(rawBody);

    await this.firestore.setDocument('subscription_audit_logs/webhook_' + Date.now(), {
      action: 'WEBHOOK_EVENT_' + event.event.toUpperCase().replace(/\./g, '_'),
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
        const existingPayment = await this.firestore.getDocument('subscription_payments/' + paymentId);
        if (!existingPayment) {
          const plan = SUBSCRIPTION_PLANS.find((p) => p.id === planId) || SUBSCRIPTION_PLANS[0];
          const startAt = nowUtc();
          const endAt = addDays(startAt, plan.durationDays);
          const subscriptionId = 'sub_' + instituteId + '_' + Date.now();
          const licenseKey = 'LIC-PAID-' + plan.id.toUpperCase() + '-' + Date.now().toString().slice(-6);

          await this.firestore.commitBatchWrites([
            {
              currentDocument: { exists: false },
              update: {
                name: 'subscription_payments/' + paymentId,
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
                name: 'institutes/' + instituteId,
                fields: {
                  subscriptionStatus: 'active',
                  activeSubscriptionId: subscriptionId,
                  planTier: plan.id,
                  licenseKey,
                  updatedAt: nowIso(),
                },
                updateMask: ['subscriptionStatus', 'activeSubscriptionId', 'planTier', 'licenseKey', 'updatedAt'],
              },
            },
            {
              update: {
                name: 'institutes/' + instituteId + '/license/current',
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
                updateMask: ['licenseKey', 'planId', 'status', 'isTrial', 'paymentId', 'activatedAt', 'validUntil', 'updatedAt'],
              },
            },
          ]);
        }
      }
    }

    return { success: true, event: event.event, received: true };
  }
}

class ExpiryService {
  constructor(env, firestore) {
    this.env = env;
    this.firestore = firestore;
  }

  async processDailyExpirations() {
    let processed = 0;
    let expired = 0;
    let notificationsSent = 0;

    const activeInstitutes = await this.firestore.runQuery('institutes', [{ field: 'subscriptionStatus', op: 'EQUAL', value: 'active' }], 100);
    const trialInstitutes = await this.firestore.runQuery('institutes', [{ field: 'subscriptionStatus', op: 'EQUAL', value: 'trial' }], 100);
    const candidates = [...activeInstitutes, ...trialInstitutes];

    for (const inst of candidates) {
      processed++;
      const instituteId = inst._id || inst.id;
      if (!instituteId) continue;

      let endAt = inst.trialEndsAt || null;
      if (inst.activeSubscriptionId) {
        const sub = await this.firestore.getDocument('subscriptions/' + inst.activeSubscriptionId);
        if (sub?.endAt) endAt = sub.endAt;
      }
      if (!endAt) continue;

      const expiryDate = new Date(endAt);
      const daysLeft = remainingDays(expiryDate);

      if (isPast(expiryDate)) {
        await this.firestore.setDocument('institutes/' + instituteId, { subscriptionStatus: 'expired', updatedAt: nowIso() });
        await this.firestore.setDocument('institutes/' + instituteId + '/license/current', { status: 'expired', updatedAt: nowIso() });
        expired++;
        const sent = await this.sendNotificationIfPending(instituteId, 'expiry_0d', 'Subscription Expired', 'Your RyuBreed Academia subscription has expired. Renew to resume cloud operations.');
        if (sent) notificationsSent++;
        continue;
      }

      if (daysLeft <= 7 && daysLeft > 2) {
        const sent = await this.sendNotificationIfPending(instituteId, 'reminder_7d', 'Subscription Reminder', 'Your RyuBreed Academia subscription expires in 7 days.');
        if (sent) notificationsSent++;
      } else if (daysLeft <= 2 && daysLeft > 1) {
        const sent = await this.sendNotificationIfPending(instituteId, 'reminder_2d', 'Subscription Reminder', 'Your RyuBreed Academia subscription expires in 2 days.');
        if (sent) notificationsSent++;
      } else if (daysLeft <= 1 && daysLeft > 0) {
        const sent = await this.sendNotificationIfPending(instituteId, 'reminder_1d', 'Subscription Expiring Tomorrow', 'Your RyuBreed Academia subscription expires tomorrow.');
        if (sent) notificationsSent++;
      }
    }

    return { processed, expired, notificationsSent };
  }

  async sendNotificationIfPending(instituteId, markerKey, title, body) {
    const markerPath = 'institutes/' + instituteId + '/notification_markers/' + markerKey;
    const existing = await this.firestore.getDocument(markerPath);
    if (existing?.status === 'sent' || existing?.status === 'no_token' || existing?.fcmSent === true) {
      return false;
    }
    if (existing?.status === 'sending' && existing?.lastAttemptAt) {
      const elapsed = Date.now() - new Date(existing.lastAttemptAt).getTime();
      if (elapsed < 5 * 60 * 1000) return false;
    }

    const attemptCount = (existing?.attempts || 0) + 1;
    await this.firestore.setDocument(markerPath, {
      markerKey,
      status: 'sending',
      attempts: attemptCount,
      lastAttemptAt: nowIso(),
      title,
      body,
    });

    if (attemptCount === 1) {
      await this.firestore.createDocument('institutes/' + instituteId, 'notifications', {
        title,
        message: body,
        type: 'subscription',
        createdAt: nowIso(),
        read: false,
      }).catch((e) => console.warn('In-app notification write notice:', e));
    }

    const deviceDoc = await this.firestore.getDocument('institutes/' + instituteId + '/settings/fcm');
    const instDoc = await this.firestore.getDocument('institutes/' + instituteId);
    const token = deviceDoc?.fcmToken || instDoc?.fcmToken;

    if (!token || token.trim().length === 0) {
      await this.firestore.setDocument(markerPath, {
        markerKey,
        status: 'no_token',
        sentAt: nowIso(),
        title,
        body,
        fcmSent: false,
        note: 'No FCM device token registered for institute',
      });
      return true;
    }

    const fcmSuccess = await sendFcmNotification(this.env, {
      token,
      title,
      body,
      data: { type: 'subscription_alert', instituteId },
    });

    if (fcmSuccess) {
      await this.firestore.setDocument(markerPath, {
        markerKey,
        status: 'sent',
        sentAt: nowIso(),
        title,
        body,
        fcmSent: true,
        attempts: attemptCount,
      });
      return true;
    } else {
      await this.firestore.setDocument(markerPath, {
        markerKey,
        status: 'failed',
        lastFailureAt: nowIso(),
        title,
        body,
        fcmSent: false,
        attempts: attemptCount,
        error: 'FCM_DELIVERY_FAILED',
      });
      return false;
    }
  }
}

// --- Main HTTP & Scheduled Handlers ---
export default {
  async fetch(request, env, ctx) {
    const allowedOriginsConfig = env.ALLOWED_ORIGINS || env.PUBLIC_APP_ORIGIN;
    const cors = resolveCorsOrigin(request, allowedOriginsConfig);

    if (request.method === 'OPTIONS') return handleCors(request, allowedOriginsConfig);

    if (request.headers.get('Origin') && !cors.isAllowed) {
      return new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'CORS origin not allowed by server policy' } }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const origin = cors.allowOriginHeader;

    const url = new URL(request.url);
    const rawPath = url.pathname;
    const path = (rawPath.length > 1 && rawPath.endsWith('/')) ? rawPath.slice(0, -1) : rawPath;
    const method = request.method.toUpperCase();

    // 1MB Payload Size Limit Enforcement
    const MAX_BODY_SIZE = 1024 * 1024;
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
      return new Response(JSON.stringify({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request payload exceeds 1MB limit' } }), {
        status: 413,
        headers: { 'Content-Type': 'application/json', ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) }
      });
    }

    try {
      const firestore = new FirestoreClient(env);

      // Public
      if (path === '/health' && method === 'GET') {
        const firestoreHealth = await firestore.checkHealth();
        const isHealthy = firestoreHealth.healthy;
        return jsonResponse({
          success: isHealthy,
          status: isHealthy ? 'healthy' : 'degraded',
          service: 'ryubreed-subscription-api',
          timestamp: nowIso(),
          dependencies: {
            firestore: {
              status: isHealthy ? 'up' : 'down',
              latencyMs: firestoreHealth.latencyMs,
              ...(firestoreHealth.error ? { error: firestoreHealth.error } : {})
            }
          }
        }, isHealthy ? 200 : 503, origin);
      }
      if (path === '/subscription/plans' && method === 'GET') {
        let plans = SUBSCRIPTION_PLANS;
        try {
          const doc = await firestore.getDocument('system_config/plans');
          if (doc && Array.isArray(doc.plans) && doc.plans.length > 0) plans = doc.plans;
        } catch {}
        return jsonResponse({ success: true, plans, trialDurationDays: 7 }, 200, origin);
      }

      // Authentication helper
      const getAuthUser = async (clientSuppliedInstituteId) => {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) throw new UnauthorizedError('Missing or malformed Authorization header');
        const token = authHeader.substring(7).trim();
        const user = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID, env);
        const instituteId = user.uid;
        if (clientSuppliedInstituteId && clientSuppliedInstituteId.trim().length > 0 && clientSuppliedInstituteId.trim() !== instituteId) {
          throw new ForbiddenError('Forbidden: Cross-institute access denied. Institute ID does not match authenticated user');
        }
        return { user, instituteId };
      };

      const getAuthAdmin = async () => {
        const apiKeyHeader = request.headers.get('X-Admin-Api-Key');
        const authHeader = request.headers.get('Authorization');
        if (env.ADMIN_API_KEY && env.ADMIN_API_KEY.trim().length > 0) {
          if (apiKeyHeader && apiKeyHeader.trim() === env.ADMIN_API_KEY.trim()) {
            return { uid: env.ADMIN_BOOTSTRAP_UID || 'node_admin_server', role: 'admin' };
          }
          if (authHeader && authHeader.startsWith('Bearer ') && authHeader.substring(7).trim() === env.ADMIN_API_KEY.trim()) {
            return { uid: env.ADMIN_BOOTSTRAP_UID || 'node_admin_server', role: 'admin' };
          }
        }
        const { user } = await getAuthUser();
        await verifyAdminUser(user.uid, env, firestore);
        return user;
      };

      // Subscription Client Endpoints
      if (path === '/subscription/status' && method === 'GET') {
        const queryInstId = url.searchParams.get('instituteId') || undefined;
        const { instituteId } = await getAuthUser(queryInstId);
        const data = await new SubscriptionService(firestore).getSubscriptionStatus(instituteId);
        return jsonResponse({ success: true, data }, 200, origin);
      }
      if (path === '/subscription/start-trial' && method === 'POST') {
        const body = await parseJsonBody(request);
        const { user, instituteId } = await getAuthUser(body.instituteId);
        const data = await new TrialService(firestore).startAutomaticTrial(instituteId, user.uid);
        return jsonResponse({ success: true, data }, 200, origin);
      }
      if (path === '/subscription/refresh' && method === 'POST') {
        const queryInstId = url.searchParams.get('instituteId') || undefined;
        const { instituteId } = await getAuthUser(queryInstId);
        const data = await new SubscriptionService(firestore).getSubscriptionStatus(instituteId);
        return jsonResponse({ success: true, refreshed: true, data }, 200, origin);
      }
      if (path === '/subscription/create-order' && method === 'POST') {
        const body = await parseJsonBody(request);
        const { user, instituteId } = await getAuthUser(body.instituteId);
        const planId = assertRequiredString(body.planId, 'planId');
        const isAnnual = Boolean(body.isAnnual);
        const data = await new PaymentService(env, firestore).createOrder(instituteId, planId, user.uid, isAnnual);
        return jsonResponse({ success: data.success, ...data, data }, 200, origin);
      }
      if (path === '/subscription/verify-payment' && method === 'POST') {
        const body = await parseJsonBody(request);
        const { user, instituteId } = await getAuthUser(body.instituteId);
        const data = await new PaymentService(env, firestore).verifyPayment({
          instituteId,
          planId: assertRequiredString(body.planId, 'planId'),
          paymentId: assertRequiredString(body.paymentId, 'paymentId'),
          orderId: assertRequiredString(body.orderId, 'orderId'),
          signature: assertRequiredString(body.signature, 'signature'),
          userUid: user.uid,
          idempotencyKey: body.idempotencyKey,
        });
        return jsonResponse({ success: data.success, data }, 200, origin);
      }
      if (path === '/subscription/webhook' && method === 'POST') {
        const signatureHeader = request.headers.get('X-Razorpay-Signature') || request.headers.get('x-razorpay-signature');
        const rawBody = await request.text();
        const data = await new PaymentService(env, firestore).processWebhook(rawBody, signatureHeader);
        return jsonResponse({ success: true, data }, 200, origin);
      }

      // Admin Endpoints
      if (path === '/admin' && method === 'GET') {
        const redirectUrl = env.ADMIN_DASHBOARD_URL && env.ADMIN_DASHBOARD_URL.trim().length > 0
          ? env.ADMIN_DASHBOARD_URL.trim()
          : 'http://localhost:3000';
        return Response.redirect(redirectUrl, 302);
      }
      if (path === '/admin/analytics' && method === 'GET') {
        await getAuthAdmin();
        const [institutes, subscriptions, payments] = await Promise.all([
          firestore.runQuery('institutes', [], 200),
          firestore.runQuery('subscriptions', [], 200),
          firestore.runQuery('subscription_payments', [], 200),
        ]);
        let activeSubscriptions = 0, activeTrials = 0, expiredSubscriptions = 0, revokedSubscriptions = 0, expiringSoon = 0;
        const now = Date.now();
        for (const inst of institutes) {
          const s = inst.subscriptionStatus;
          if (s === 'active') activeSubscriptions++;
          else if (s === 'trial') activeTrials++;
          else if (s === 'expired') expiredSubscriptions++;
          else if (s === 'revoked') revokedSubscriptions++;
          if (inst.trialEndsAt) {
            const endMs = new Date(inst.trialEndsAt).getTime();
            if (endMs > now && endMs - now <= 7 * 24 * 60 * 60 * 1000) expiringSoon++;
          }
        }
        let totalRevenueINR = 0;
        for (const p of payments) {
          const a = Number(p.amount || 0);
          if (!isNaN(a)) totalRevenueINR += a;
        }
        return jsonResponse({
          success: true,
          data: {
            totalInstitutes: institutes.length, activeSubscriptions, activeTrials, expiredSubscriptions, revokedSubscriptions,
            trialsExpiringSoon: expiringSoon, totalRevenueINR, verifiedPaymentsCount: payments.length, timestamp: nowIso()
          }
        }, 200, origin);
      }
      if (path === '/admin/institutes' && method === 'GET') {
        await getAuthAdmin();
        const search = url.searchParams.get('search')?.toLowerCase() || '';
        let list = await firestore.runQuery('institutes', [], 100);
        if (search) {
          list = list.filter((i) => String(i.name || '').toLowerCase().includes(search) || String(i.email || '').toLowerCase().includes(search) || String(i._id || i.id || '').toLowerCase().includes(search));
        }
        return jsonResponse({ success: true, count: list.length, data: list }, 200, origin);
      }
      if (path === '/admin/subscriptions' && method === 'GET') {
        await getAuthAdmin();
        const status = url.searchParams.get('status');
        const filters = status && status !== 'all' ? [{ field: 'status', op: 'EQUAL', value: status }] : [];
        const list = await firestore.runQuery('subscriptions', filters, 100);
        return jsonResponse({ success: true, count: list.length, data: list }, 200, origin);
      }
      if (path.startsWith('/admin/subscriptions/') && method === 'GET') {
        await getAuthAdmin();
        const subId = path.substring('/admin/subscriptions/'.length);
        const sub = await firestore.getDocument('subscriptions/' + subId);
        if (!sub) throw new NotFoundError('Subscription ' + subId + ' not found');
        return jsonResponse({ success: true, data: sub }, 200, origin);
      }
      if (path === '/admin/trials/grant' && method === 'POST') {
        const body = await parseJsonBody(request);
        const admin = await getAuthAdmin();
        const instituteId = assertRequiredString(body.instituteId, 'instituteId');
        const durationDays = assertRequiredNumber(body.durationDays, 'durationDays', 0.01);
        const reason = assertRequiredString(body.reason, 'reason');
        const idempotencyKey = body.idempotencyKey || request.headers.get('idempotency-key') || undefined;

        if (idempotencyKey && idempotencyKey.trim().length > 0) {
          const cacheKey = 'admin_idempotency/' + admin.uid + '_' + idempotencyKey.trim();
          const cached = await firestore.getDocument(cacheKey);
          if (cached?.result) {
            return jsonResponse({ success: true, data: cached.result, idempotentReplay: true }, 200, origin);
          }
          const data = await new TrialService(firestore).grantAdminTrial(instituteId, durationDays, reason, admin.uid);
          await firestore.setDocument(cacheKey, { adminUid: admin.uid, idempotencyKey: idempotencyKey.trim(), instituteId, result: data, createdAt: nowIso() });
          return jsonResponse({ success: true, data }, 200, origin);
        }

        const data = await new TrialService(firestore).grantAdminTrial(instituteId, durationDays, reason, admin.uid);
        return jsonResponse({ success: true, data }, 200, origin);
      }
      if (path === '/admin/subscriptions/extend' && method === 'POST') {
        const body = await parseJsonBody(request);
        const admin = await getAuthAdmin();
        const subId = assertRequiredString(body.subscriptionId, 'subscriptionId');
        const days = assertRequiredNumber(body.days, 'days', 1);
        const reason = assertRequiredString(body.reason, 'reason');
        const idempotencyKey = body.idempotencyKey || request.headers.get('idempotency-key') || undefined;

        if (idempotencyKey && idempotencyKey.trim().length > 0) {
          const cacheKey = 'admin_idempotency/' + admin.uid + '_' + idempotencyKey.trim();
          const cached = await firestore.getDocument(cacheKey);
          if (cached?.result) {
            return jsonResponse({ success: true, data: cached.result, idempotentReplay: true }, 200, origin);
          }
        }

        const sub = await firestore.getDocument('subscriptions/' + subId);
        if (!sub || !sub.instituteId) throw new NotFoundError('Subscription ' + subId + ' not found');

        const currentEnd = sub.endAt ? new Date(sub.endAt) : new Date();
        const newEnd = addDays(currentEnd, days);
        await firestore.commitBatchWrites([
          {
            update: {
              name: 'subscriptions/' + subId,
              fields: { endAt: newEnd.toISOString(), status: 'active', updatedAt: nowIso() },
              updateMask: ['endAt', 'status', 'updatedAt']
            }
          },
          {
            update: {
              name: 'institutes/' + sub.instituteId,
              fields: { subscriptionStatus: 'active', updatedAt: nowIso() },
              updateMask: ['subscriptionStatus', 'updatedAt']
            }
          },
          {
            update: {
              name: 'institutes/' + sub.instituteId + '/license/current',
              fields: { status: 'active', validUntil: newEnd.toISOString(), updatedAt: nowIso() },
              updateMask: ['status', 'validUntil', 'updatedAt']
            }
          },
          {
            update: {
              name: 'subscription_audit_logs/log_' + Date.now(),
              fields: {
                action: 'ADMIN_SUBSCRIPTION_EXTENDED', instituteId: sub.instituteId, performedBy: admin.uid,
                oldValue: sub.endAt || 'none', newValue: newEnd.toISOString(), reason, timestamp: nowIso()
              }
            }
          }
        ]);
        const resultData = { subscriptionId: subId, instituteId: sub.instituteId, newEndAt: newEnd.toISOString() };
        if (idempotencyKey && idempotencyKey.trim().length > 0) {
          const cacheKey = 'admin_idempotency/' + admin.uid + '_' + idempotencyKey.trim();
          await firestore.setDocument(cacheKey, { adminUid: admin.uid, idempotencyKey: idempotencyKey.trim(), subscriptionId: subId, result: resultData, createdAt: nowIso() });
        }
        return jsonResponse({ success: true, data: resultData }, 200, origin);
      }
      if (path === '/admin/subscriptions/revoke' && method === 'POST') {
        const body = await parseJsonBody(request);
        const admin = await getAuthAdmin();
        const instituteId = assertRequiredString(body.instituteId, 'instituteId');
        const reason = assertRequiredString(body.reason, 'reason');
        const idempotencyKey = body.idempotencyKey || request.headers.get('idempotency-key') || undefined;

        if (idempotencyKey && idempotencyKey.trim().length > 0) {
          const cacheKey = 'admin_idempotency/' + admin.uid + '_' + idempotencyKey.trim();
          const cached = await firestore.getDocument(cacheKey);
          if (cached?.result) {
            return jsonResponse({ success: true, data: cached.result, idempotentReplay: true }, 200, origin);
          }
          const data = await new TrialService(firestore).revokeSubscription(instituteId, reason, admin.uid);
          await firestore.setDocument(cacheKey, { adminUid: admin.uid, idempotencyKey: idempotencyKey.trim(), instituteId, result: data, createdAt: nowIso() });
          return jsonResponse({ success: true, data }, 200, origin);
        }

        const data = await new TrialService(firestore).revokeSubscription(instituteId, reason, admin.uid);
        return jsonResponse({ success: true, data }, 200, origin);
      }
      if (path === '/admin/audit-logs' && method === 'GET') {
        await getAuthAdmin();
        const list = await firestore.runQuery('subscription_audit_logs', [], 100);
        return jsonResponse({ success: true, count: list.length, data: list }, 200, origin);
      }
      if (path === '/admin/plans' && method === 'GET') {
        await getAuthAdmin();
        let plans = SUBSCRIPTION_PLANS;
        try {
          const doc = await firestore.getDocument('system_config/plans');
          if (doc && Array.isArray(doc.plans) && doc.plans.length > 0) plans = doc.plans;
        } catch {}
        return jsonResponse({ success: true, plans }, 200, origin);
      }
      if (path === '/admin/plans' && (method === 'PUT' || method === 'POST')) {
        const admin = await getAuthAdmin();
        const body = await parseJsonBody(request);
        if (!body.plans || !Array.isArray(body.plans) || body.plans.length === 0) {
          throw new AppError('Invalid plans: Array of plans is required', 400);
        }
        const sanitizedPlans = body.plans.map((p) => {
          const id = assertRequiredString(p.id, 'plan.id');
          const name = assertRequiredString(p.name, 'plan.name');
          const priceINR = assertRequiredNumber(p.priceINR, 'plan.priceINR');
          if (priceINR < 1) throw new AppError('Plan price for ' + name + ' must be at least ₹1', 400);
          const annualPriceINR = typeof p.annualPriceINR === 'number' && p.annualPriceINR >= 1 ? p.annualPriceINR : priceINR * 12;
          const durationDays = typeof p.durationDays === 'number' && p.durationDays > 0 ? p.durationDays : 30;
          const features = Array.isArray(p.features) ? p.features.filter((f) => typeof f === 'string') : [];
          return { id, name, priceINR, annualPriceINR, durationDays, features };
        });
        const payload = { plans: sanitizedPlans, updatedAt: nowIso(), updatedBy: admin.uid };
        await firestore.setDocument('system_config/plans', payload);
        await firestore.setDocument('subscription_audit_logs/' + Date.now() + '_plans_update', {
          action: 'PLANS_UPDATED', adminUid: admin.uid, plans: sanitizedPlans, timestamp: nowIso()
        });
        return jsonResponse({ success: true, plans: sanitizedPlans, message: 'Subscription plans updated successfully' }, 200, origin);
      }

      return new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Route ' + method + ' ' + path + ' not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin }
      });
    } catch (err) {
      return errorResponse(err, origin);
    }
  },

  async scheduled(event, env, ctx) {
    console.log('[Cron Trigger] Starting hourly expiration & notification sweep...');
    const firestore = new FirestoreClient(env);
    const service = new ExpiryService(env, firestore);
    ctx.waitUntil(
      service.processDailyExpirations().then((res) => {
        console.log('[Cron Trigger] Complete. Processed: ' + res.processed + ', Expired: ' + res.expired + ', FCM Sent: ' + res.notificationsSent);
      }).catch((e) => {
        console.error('[Cron Trigger Error]:', e);
      })
    );
  }
};

export {
  TrialService,
  ExpiryService,
  SubscriptionService,
  PaymentService,
  FirestoreClient,
  SUBSCRIPTION_PLANS,
  DEFAULT_TRIAL_DAYS
};
`;

const finalWorkerJs = workerSource;

const outputPath = path.join(__dirname, 'worker.js');
fs.writeFileSync(outputPath, finalWorkerJs, 'utf8');
console.log('Successfully generated standalone worker.js (' + finalWorkerJs.length + ' bytes)');
