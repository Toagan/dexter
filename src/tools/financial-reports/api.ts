import { readCache, writeCache, describeRequest } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_BASE_URL = 'https://api.financialreports.eu';

function getBaseUrl(): string {
  return process.env.FINANCIAL_REPORTS_BASE_URL || DEFAULT_BASE_URL;
}

function getApiKey(): string {
  return process.env.FINANCIAL_REPORTS_API_KEY || '';
}

type ParamValue = string | number | boolean | string[] | number[] | undefined;
type Params = Record<string, ParamValue>;

function appendParams(url: URL, params: Params): void {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((v) => url.searchParams.append(key, String(v)));
    } else {
      url.searchParams.append(key, String(value));
    }
  }
}

async function executeRequest(
  url: string,
  label: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const apiKey = getApiKey();

  if (!apiKey) {
    logger.warn(`[FinancialReports API] call without key: ${label}`);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[FinancialReports API] network error: ${label} — ${message}`);
    throw new Error(`[FinancialReports API] request failed for ${label}: ${message}`);
  }

  // FR returns 403 (not 401) on missing/invalid keys — caller branches on .ok already.
  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      // ignore
    }
    const detail = `${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`;
    logger.error(`[FinancialReports API] error: ${label} — ${detail}`);
    throw new Error(`[FinancialReports API] request failed: ${detail}`);
  }

  // Some DELETE endpoints return 204 No Content
  if (response.status === 204) {
    return { ok: true };
  }

  const text = await response.text();
  if (!text) {
    return { ok: true };
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const detail = `invalid JSON (${response.status} ${response.statusText})`;
    logger.error(`[FinancialReports API] parse error: ${label} — ${detail}`);
    throw new Error(`[FinancialReports API] request failed: ${detail}`);
  }
}

function paramsForCacheKey(params: Params): Record<string, string | number | string[] | undefined> {
  const out: Record<string, string | number | string[] | undefined> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      out[k] = v.map(String);
    } else if (typeof v === 'boolean') {
      out[k] = String(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const frApi = {
  async get(
    endpoint: string,
    params: Params,
    options?: { cacheable?: boolean; ttlMs?: number },
  ): Promise<{ data: Record<string, unknown>; url: string }> {
    const cacheParams = paramsForCacheKey(params);
    const label = describeRequest(endpoint, cacheParams);

    if (options?.cacheable) {
      const cached = readCache(`fr:${endpoint}`, cacheParams, options.ttlMs);
      if (cached) {
        return cached;
      }
    }

    const url = new URL(`${getBaseUrl()}${endpoint}`);
    appendParams(url, params);

    const data = await executeRequest(url.toString(), label, { method: 'GET' });

    if (options?.cacheable) {
      writeCache(`fr:${endpoint}`, cacheParams, data, url.toString());
    }

    return { data, url: url.toString() };
  },

  async post(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown>; url: string }> {
    const url = `${getBaseUrl()}${endpoint}`;
    const label = `POST ${endpoint}`;
    const data = await executeRequest(url, label, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { data, url };
  },

  async del(endpoint: string): Promise<{ data: Record<string, unknown>; url: string }> {
    const url = `${getBaseUrl()}${endpoint}`;
    const label = `DELETE ${endpoint}`;
    const data = await executeRequest(url, label, { method: 'DELETE' });
    return { data, url };
  },
};
