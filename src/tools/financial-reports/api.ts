import { readCache, writeCache, describeRequest } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_BASE_URL = 'https://api.financialreports.eu';

function getBaseUrl(): string {
  return process.env.FINANCIAL_REPORTS_BASE_URL || DEFAULT_BASE_URL;
}

function getApiKey(): string {
  return process.env.FINANCIAL_REPORTS_API_KEY || '';
}

/**
 * Shared request execution for FinancialReports.eu API.
 */
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
        'Accept': 'application/json',
        ...init.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[FinancialReports API] network error: ${label} — ${message}`);
    throw new Error(`[FinancialReports API] request failed for ${label}: ${message}`);
  }

  if (!response.ok) {
    const detail = `${response.status} ${response.statusText}`;
    logger.error(`[FinancialReports API] error: ${label} — ${detail}`);
    throw new Error(`[FinancialReports API] request failed: ${detail}`);
  }

  const data = await response.json().catch(() => {
    const detail = `invalid JSON (${response.status} ${response.statusText})`;
    logger.error(`[FinancialReports API] parse error: ${label} — ${detail}`);
    throw new Error(`[FinancialReports API] request failed: ${detail}`);
  });

  return data as Record<string, unknown>;
}

export const frApi = {
  async get(
    endpoint: string,
    params: Record<string, string | number | string[] | undefined>,
    options?: { cacheable?: boolean; ttlMs?: number },
  ): Promise<{ data: Record<string, unknown>; url: string }> {
    const label = describeRequest(endpoint, params);

    if (options?.cacheable) {
      const cached = readCache(`fr:${endpoint}`, params, options.ttlMs);
      if (cached) {
        return cached;
      }
    }

    const url = new URL(`${getBaseUrl()}${endpoint}`);

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value)) {
          value.forEach((v) => url.searchParams.append(key, v));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }

    const data = await executeRequest(url.toString(), label, {});

    if (options?.cacheable) {
      writeCache(`fr:${endpoint}`, params, data, url.toString());
    }

    return { data, url: url.toString() };
  },
};
