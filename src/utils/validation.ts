import { AppError } from './errors';

export function assertRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(`Missing or invalid required field: ${fieldName}`, 400, 'INVALID_INPUT');
  }
  return value.trim();
}

export function assertRequiredNumber(value: unknown, fieldName: string, min = 0): number {
  if (typeof value !== 'number' || isNaN(value) || value < min) {
    throw new AppError(`Field ${fieldName} must be a number >= ${min}`, 400, 'INVALID_INPUT');
  }
  return value;
}

export function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Reads and parses JSON request body with strict byte size limit enforcement.
 * Inspects Content-Length header AND enforces streamed byte limit chunk-by-chunk
 * to prevent memory exhaustion / DoS attacks from chunked streaming without headers.
 */
export async function parseJsonBody<T = Record<string, unknown>>(
  request: Request,
  maxBytes: number = 1024 * 1024 // 1MB default
): Promise<T> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new AppError('Request payload exceeds 1MB limit', 413, 'PAYLOAD_TOO_LARGE');
  }

  if (!request.body) {
    return {} as T;
  }

  if (typeof request.body.getReader !== 'function') {
    return (await request.json().catch(() => ({}))) as T;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
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

  if (chunks.length === 0) {
    return {} as T;
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  const text = new TextDecoder('utf-8').decode(merged);
  if (!text.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Malformed JSON payload', 400, 'BAD_REQUEST');
  }
}

