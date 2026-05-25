import { frApi } from './api.js';
import { TTL_24H } from '../utils.js';

/**
 * A resolved FinancialReports company. The `id` is an FR-internal integer —
 * NOT a ticker or ISIN — and is required by every per-company endpoint.
 */
export interface FrCompany {
  id: number;
  name: string;
  isin?: string;
  country?: string;
  raw: Record<string, unknown>;
}

/** DRF-style paginated list envelope. */
interface FrList {
  count?: number;
  results?: Record<string, unknown>[];
}

function toCompany(record: Record<string, unknown>): FrCompany {
  return {
    id: Number(record.id),
    name: String(record.name ?? record.company_name ?? ''),
    isin: typeof record.isin === 'string' ? record.isin : undefined,
    country: typeof record.country === 'string' ? record.country : undefined,
    raw: record,
  };
}

function firstResult(data: Record<string, unknown>): Record<string, unknown> | null {
  const list = data as FrList;
  if (Array.isArray(list.results) && list.results.length > 0) {
    return list.results[0];
  }
  return null;
}

/**
 * Resolve a company to its FR-internal id. Accepts an ISIN (preferred — exact)
 * or a free-text name/ticker (best match via search).
 *
 * Note: FR's `search` works on `/companies/` but is broken on `/filings/`, so all
 * filing/financials lookups MUST resolve the company here first.
 *
 * @returns the best-matching company, or null if nothing matched.
 */
export async function resolveCompany(input: {
  isin?: string;
  name?: string;
}): Promise<FrCompany | null> {
  // ISIN is exact — prefer it.
  if (input.isin) {
    const isin = input.isin.trim().toUpperCase();
    const { data } = await frApi.get('/companies/', { isin }, { cacheable: true, ttlMs: TTL_24H });
    const hit = firstResult(data);
    if (hit) {
      return toCompany(hit);
    }
    // Fall back to the ISIN registry, which maps ISIN -> company id.
    const { data: isinData } = await frApi.get('/isins/', { code: isin }, { cacheable: true, ttlMs: TTL_24H });
    const isinHit = firstResult(isinData);
    const companyId = isinHit?.company;
    if (companyId !== undefined && companyId !== null) {
      const { data: detail } = await frApi.get(
        `/companies/${Number(companyId)}/`,
        {},
        { cacheable: true, ttlMs: TTL_24H },
      );
      return toCompany(detail);
    }
    return null;
  }

  if (input.name) {
    const { data } = await frApi.get(
      '/companies/',
      { search: input.name.trim() },
      { cacheable: true, ttlMs: TTL_24H },
    );
    const hit = firstResult(data);
    return hit ? toCompany(hit) : null;
  }

  return null;
}
