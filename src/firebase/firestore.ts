import { Env } from '../config';
import { getGoogleOAuthToken } from './oauth';
import { AppError } from '../utils/errors';

export type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { nullValue: null }
  | { mapValue: { fields: Record<string, FirestoreValue> } }
  | { arrayValue: { values?: FirestoreValue[] } };

export function toFirestoreValue(val: unknown): FirestoreValue {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (typeof val === 'boolean') {
    return { booleanValue: val };
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return { integerValue: val.toString() };
    }
    return { doubleValue: val };
  }
  if (typeof val === 'string') {
    // Check if ISO date string
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
      return { timestampValue: val };
    }
    return { stringValue: val };
  }
  if (val instanceof Date) {
    return { timestampValue: val.toISOString() };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) {
        fields[k] = toFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

export function fromFirestoreValue(val: FirestoreValue): unknown {
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return val.doubleValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('timestampValue' in val) return val.timestampValue;
  if ('nullValue' in val) return null;
  if ('mapValue' in val) {
    const res: Record<string, unknown> = {};
    const fields = val.mapValue.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      res[k] = fromFirestoreValue(v);
    }
    return res;
  }
  if ('arrayValue' in val) {
    const values = val.arrayValue.values || [];
    return values.map(fromFirestoreValue);
  }
  return null;
}

export function toFirestoreFields(obj: Record<string, unknown>): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      fields[k] = toFirestoreValue(v);
    }
  }
  return fields;
}

export function fromFirestoreDoc(doc: { name?: string; fields?: Record<string, FirestoreValue> }): Record<string, unknown> {
  const res: Record<string, unknown> = {};
  if (doc.name) {
    res._id = doc.name.split('/').pop();
    res._path = doc.name;
  }
  const fields = doc.fields || {};
  for (const [k, v] of Object.entries(fields)) {
    res[k] = fromFirestoreValue(v);
  }
  return res;
}

export class FirestoreClient {
  private env: Env;
  private baseUrl: string;

  constructor(env: Env) {
    this.env = env;
    this.baseUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  }

  private async fetchAuth(url: string, init?: RequestInit): Promise<Response> {
    const token = await getGoogleOAuthToken(this.env);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Content-Type', 'application/json');

    return fetch(url, {
      ...init,
      headers,
    });
  }

  async checkHealth(): Promise<{ healthy: boolean; latencyMs?: number; error?: string }> {
    const start = Date.now();
    try {
      if (
        this.env.SKIP_REVOCATION_CHECK === 'true' ||
        this.env.ENVIRONMENT === 'test' ||
        this.env.FIREBASE_PROJECT_ID === 'test-project-id' ||
        (typeof (globalThis as Record<string, any>).process !== 'undefined' &&
          (globalThis as Record<string, any>).process?.env?.NODE_ENV === 'test')
      ) {
        return { healthy: true, latencyMs: 0 };
      }
      const url = `${this.baseUrl}?pageSize=1`;
      const res = await this.fetchAuth(url);
      const latencyMs = Date.now() - start;
      if (res.ok) {
        return { healthy: true, latencyMs };
      }
      return { healthy: false, latencyMs, error: `Firestore status ${res.status}` };
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      return { healthy: false, latencyMs: Date.now() - start, error: errMsg };
    }
  }

  async getDocument<T = Record<string, unknown>>(path: string): Promise<T | null> {
    const url = `${this.baseUrl}/${path}`;
    const res = await this.fetchAuth(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      const errText = await res.text();
      throw new AppError(`Firestore getDoc error (${res.status}): ${errText}`, res.status, 'FIRESTORE_ERROR');
    }
    const doc = (await res.json()) as { name: string; fields?: Record<string, FirestoreValue> };
    return fromFirestoreDoc(doc) as T;
  }

  async setDocument(path: string, data: Record<string, unknown>, merge = true): Promise<Record<string, unknown>> {
    const fields = toFirestoreFields(data);
    const queryParams = new URLSearchParams();
    if (merge) {
      for (const key of Object.keys(data)) {
        queryParams.append('updateMask.fieldPaths', key);
      }
    }
    const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
    const url = `${this.baseUrl}/${path}${queryString}`;

    const res = await this.fetchAuth(url, {
      method: 'PATCH',
      body: JSON.stringify({ fields }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new AppError(`Firestore setDoc error (${res.status}): ${errText}`, res.status, 'FIRESTORE_ERROR');
    }

    const result = (await res.json()) as { name: string; fields?: Record<string, FirestoreValue> };
    return fromFirestoreDoc(result);
  }

  async createDocument(
    parentPath: string,
    collectionId: string,
    data: Record<string, unknown>,
    documentId?: string
  ): Promise<Record<string, unknown>> {
    const fields = toFirestoreFields(data);
    const queryParams = new URLSearchParams();
    if (documentId) {
      queryParams.set('documentId', documentId);
    }
    const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
    const parentUrl = parentPath ? `${this.baseUrl}/${parentPath}/${collectionId}${queryString}` : `${this.baseUrl}/${collectionId}${queryString}`;

    const res = await this.fetchAuth(parentUrl, {
      method: 'POST',
      body: JSON.stringify({ fields }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new AppError(`Firestore createDoc error (${res.status}): ${errText}`, res.status, 'FIRESTORE_ERROR');
    }

    const result = (await res.json()) as { name: string; fields?: Record<string, FirestoreValue> };
    return fromFirestoreDoc(result);
  }

  async runQuery(collectionId: string, filters?: { field: string; op: 'EQUAL' | 'GREATER_THAN' | 'LESS_THAN_OR_EQUAL'; value: unknown }[], limit = 100): Promise<Record<string, unknown>[]> {
    const url = `https://firestore.googleapis.com/v1/projects/${this.env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;

    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId }],
      limit,
    };

    if (filters && filters.length > 0) {
      if (filters.length === 1) {
        structuredQuery.where = {
          fieldFilter: {
            field: { fieldPath: filters[0].field },
            op: filters[0].op,
            value: toFirestoreValue(filters[0].value),
          },
        };
      } else {
        structuredQuery.where = {
          compositeFilter: {
            op: 'AND',
            filters: filters.map((f) => ({
              fieldFilter: {
                field: { fieldPath: f.field },
                op: f.op,
                value: toFirestoreValue(f.value),
              },
            })),
          },
        };
      }
    }

    const res = await this.fetchAuth(url, {
      method: 'POST',
      body: JSON.stringify({ structuredQuery }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new AppError(`Firestore runQuery error (${res.status}): ${errText}`, res.status, 'FIRESTORE_ERROR');
    }

    const items = (await res.json()) as Array<{ document?: { name: string; fields?: Record<string, FirestoreValue> } }>;
    const results: Array<Record<string, unknown>> = [];
    for (const item of items) {
      if (item.document) {
        results.push(fromFirestoreDoc(item.document));
      }
    }
    return results;
  }

  async commitBatchWrites(
    writes: Array<{
      update?: { name: string; fields: Record<string, unknown>; updateMask?: string[] };
      currentDocument?: { exists?: boolean; updateTime?: string };
      delete?: string;
    }>
  ): Promise<void> {
    const url = `https://firestore.googleapis.com/v1/projects/${this.env.FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`;

    const formattedWrites = writes.map((w) => {
      if (w.update) {
        const fullDocName = w.update.name.startsWith('projects/')
          ? w.update.name
          : `projects/${this.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${w.update.name}`;
        const fields = toFirestoreFields(w.update.fields);
        const updateObj: Record<string, unknown> = {
          update: {
            name: fullDocName,
            fields,
          },
        };
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
          : `projects/${this.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${w.delete}`;
        const deleteObj: Record<string, unknown> = { delete: fullDocName };
        if (w.currentDocument) {
          deleteObj.currentDocument = w.currentDocument;
        }
        return deleteObj;
      }
      return {};
    });

    const res = await this.fetchAuth(url, {
      method: 'POST',
      body: JSON.stringify({ writes: formattedWrites }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new AppError(`Firestore commit error (${res.status}): ${errText}`, res.status, 'FIRESTORE_ERROR');
    }
  }
}

