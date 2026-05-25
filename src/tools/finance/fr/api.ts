import { readCache, writeCache, describeRequest } from '../../../utils/cache.js';
import { logger } from '../../../utils/logger.js';

/**
 * Client for the FinancialReports.eu API.
 *
 * FR is the international complement to the US-centric Financial Datasets API:
 * G20 coverage (EU / APAC / LATAM + US), ISIN-based resolution, Capital-IQ-grade
 * standardized financials, and AI-extracted filing markdown in many languages.
 *
 * Mirrors the shape of ../api.ts (the Financial Datasets client) so the two data
 * sources stay symmetric and the cache layer is shared.
 */

const BASE_URL = 'https://api.financialreports.eu';

export interface FrApiResponse {
  data: Record<string, unknown>;
  url: string;
}

export function getFrApiKey(): string {
  return process.env.FINANCIAL_REPORTS_API_KEY || '';
}

/** True when an FR key is configured. Used to gate tool registration. */
export function hasFrApiKey(): boolean {
  return Boolean(getFrApiKey());
}

async function fetchRaw(url: string, label: string): Promise<Response> {
  const apiKey = getFrApiKey();

  if (!apiKey) {
    logger.warn(`[FinancialReports API] call without key: ${label}`);
  }

  let response: Response;
  try {
    response = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[FinancialReports API] network error: ${label} — ${message}`);
    throw new Error(`[FinancialReports API] request failed for ${label}: ${message}`);
  }

  // FR returns 403 (not 401) on auth failure — see operator notes. Branch on the
  // status explicitly so the error message is actionable.
  if (response.status === 403) {
    logger.error(`[FinancialReports API] auth error (403): ${label}`);
    throw new Error(
      `[FinancialReports API] authentication failed (403) for ${label}. Check FINANCIAL_REPORTS_API_KEY.`,
    );
  }

  if (!response.ok) {
    const detail = `${response.status} ${response.statusText}`;
    logger.error(`[FinancialReports API] error: ${label} — ${detail}`);
    throw new Error(`[FinancialReports API] request failed: ${detail}`);
  }

  return response;
}

async function executeRequest(url: string, label: string): Promise<Record<string, unknown>> {
  const response = await fetchRaw(url, label);

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
    params: Record<string, string | number | boolean | undefined> = {},
    options?: { cacheable?: boolean; ttlMs?: number },
  ): Promise<FrApiResponse> {
    const label = describeRequest(endpoint, params as Record<string, string | number | string[] | undefined>);

    if (options?.cacheable) {
      const cached = readCache(endpoint, params as Record<string, string | number | string[] | undefined>, options.ttlMs);
      if (cached) {
        return cached;
      }
    }

    const url = new URL(`${BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    }

    const data = await executeRequest(url.toString(), label);

    if (options?.cacheable) {
      writeCache(endpoint, params as Record<string, string | number | string[] | undefined>, data, url.toString());
    }

    return { data, url: url.toString() };
  },

  /**
   * GET an endpoint that returns a raw text body rather than JSON.
   * `/filings/{id}/markdown/` returns text/markdown, not a JSON envelope.
   */
  async getText(endpoint: string): Promise<{ text: string; url: string }> {
    const url = `${BASE_URL}${endpoint}`;
    const response = await fetchRaw(url, `GET ${endpoint} (text)`);
    const text = await response.text();
    return { text, url };
  },
};
