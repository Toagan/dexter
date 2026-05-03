import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { frApi } from './api.js';
import { withTimeout, TTL_15M, TTL_1H, TTL_6H, TTL_24H } from '../../utils/timeout.js';
import { logger } from '../../utils/logger.js';

const TIMEOUT_MS = 30_000;

// ============================================================================
// Tool description (injected into the system prompt)
// ============================================================================

export const FR_RESEARCH_DESCRIPTION = `
Unified research tool backed by FinancialReports.eu — the sole source of structured financial data in this build of Dexter. Covers companies, regulatory filings, standardized line-item financials, identifier resolution, and watchlist management for ~46K companies / 20M+ filings across G20 markets (SEC, EDINET, OpenDART, BaFin, AMF, FCA, TWSE, HKEX, SEDAR, ASX, NSE/BSE, CNINFO, B3, JSE, etc.).

## When to use this tool

- Looking up any company by name / ticker / ISIN / LEI worldwide
- Listing or filtering regulatory filings (annual reports, quarterly reports, press releases, etc.)
- Reading the full markdown text of a filing (with raw-document fallback when markdown isn't ready)
- Pulling standardized financial statements (BS / IS / CFS) using 126 Capital-IQ-grade KPI codes
- Predicting when a company's next annual report will land
- Resolving an ISIN to a company / FIGI mapping
- Fetching the audit trail / state-transition log for a filing
- Browsing reference data: countries, languages, sources, filing types/categories, line-item taxonomy
- Managing the user's watchlist (single or bulk add/remove)

## When NOT to use this tool

- Real-time stock or crypto quotes — FR has no quote feed; use web_search / web_fetch
- Breaking news, headlines, social signals — use web_search / x_search
- Insider trades, institutional ownership, options flow — not exposed by FR
- Analyst consensus estimates / forward EPS — not exposed by FR
- Pre-2024 historicals — FR coverage is shallow for older periods; use web_fetch on archived filings if needed

## Actions

### Companies
- search_companies(query) — fuzzy search across name / LEI / ticker / ISINs
- get_company(company_id) — rich detail (50+ fields)
- get_financials(company_id, statement_type?, fiscal_year_from?, fiscal_year_to?, fiscal_period?, line_items?) — Capital-IQ-standardized BS / IS / CFS
- get_next_annual_report(company_id) — predicted release window with confidence score

### Filings
- search_filings(countries?, filing_type?, filing_types?, filing_category?, company_id?, company_isin?, fiscal_year?, fiscal_period?, release_datetime_from?, release_datetime_to?) — list with filters
- get_filing(filing_id) — full filing detail incl. processing_status and raw document URL
- read_filing(filing_id) — fetches the AI-extracted markdown if processing_status=COMPLETED; otherwise returns the raw document URL with a note for the caller to use web_fetch
- get_filing_history(filing_id) — full state-transition audit trail (extraction timestamps, classifier confidences)

### Identifiers / taxonomy
- resolve_isin(company_isin) — single ISIN → company + FIGI mapping
- list_line_items() — the 126 Capital-IQ-standard KPI codes with hierarchy and aliases

### Reference data
- list_countries() — 249 countries (ISO 3166)
- list_filing_types() — 39 codes (10-K, 10-Q, 20-F, ER, IR, RNS, etc.)
- list_filing_categories() — 11 high-level categories
- list_sources() — 35 visible regulators / exchanges (note: 13 G20 sources are live but not listed)

### Watchlist
- get_watchlist()
- add_to_watchlist(company_id)
- remove_from_watchlist(company_id)
- bulk_watchlist(company_ids[], watchlist_action) — bulk add/remove in one call

## Workflow notes

- Resolve identity first: search_companies → company_id, then call other actions with that ID.
- For non-US tickers, country codes are ISO 3166-1 alpha-2 (DE, JP, GB, FR, CN, KR, BR, IN, etc.).
- Filter parameter names: countries (plural), company_isin (singular), type/types, category/categories. Other variants are silently ignored by the API.
- read_filing falls back gracefully — when markdown isn't ready it returns the raw document URL plus a hint; pipe that through web_fetch to extract HTML, or surface the URL to the user for PDF/XBRL.
`.trim();

// ============================================================================
// Input schema
// ============================================================================

const ActionSchema = z.enum([
  // Companies
  'search_companies',
  'get_company',
  'get_financials',
  'get_next_annual_report',
  // Filings
  'search_filings',
  'get_filing',
  'read_filing',
  'get_filing_history',
  // Identifiers / taxonomy
  'resolve_isin',
  'list_line_items',
  // Reference
  'list_countries',
  'list_filing_types',
  'list_filing_categories',
  'list_sources',
  // Watchlist
  'get_watchlist',
  'add_to_watchlist',
  'remove_from_watchlist',
  'bulk_watchlist',
]);

const InputSchema = z.object({
  action: ActionSchema.describe('FR API action to perform'),

  // Identifiers
  query: z.string().optional().describe('Free-text search (search_companies)'),
  company_id: z.number().int().optional().describe('FR internal company ID'),
  company_isin: z.string().optional().describe('ISIN (resolve_isin or as filter on search_filings)'),
  filing_id: z.number().int().optional().describe('FR filing ID'),

  // Filing filters
  countries: z.string().optional().describe('Comma-separated ISO-2 country codes (e.g. DE,FR,JP)'),
  filing_type: z.string().optional().describe('Single filing type code (e.g. 10-K, IR, ER)'),
  filing_types: z.string().optional().describe('Comma-separated filing type codes'),
  filing_category: z.number().int().optional().describe('Single filing category id'),
  fiscal_year: z.number().int().optional(),
  fiscal_period: z.enum(['FY', 'H1', 'H2', 'Q1', 'Q2', 'Q3', 'Q4', '9M']).optional(),
  release_datetime_from: z.string().optional().describe('ISO datetime (YYYY-MM-DDTHH:MM:SSZ)'),
  release_datetime_to: z.string().optional().describe('ISO datetime (YYYY-MM-DDTHH:MM:SSZ)'),

  // Financials filters (L3)
  statement_type: z.enum(['BS', 'IS', 'CFS']).optional().describe('Balance Sheet / Income Statement / Cash Flow Statement'),
  fiscal_year_from: z.number().int().optional(),
  fiscal_year_to: z.number().int().optional(),
  line_items: z.string().optional().describe('Comma-separated KPI codes (e.g. revenue,ebitda,net_income_loss)'),

  // Watchlist
  company_ids: z.array(z.number().int()).optional().describe('Array of company IDs (bulk_watchlist)'),
  watchlist_action: z.enum(['add', 'remove']).optional().describe('add or remove (bulk_watchlist)'),

  // Pagination + view
  page: z.number().int().optional(),
  page_size: z.number().int().optional().describe('Default 10 for searches, 20 for filings, 100 for reference data; max 100'),
  ordering: z.string().optional().describe('Sort field; prefix - for descending'),
  view: z.enum(['summary', 'full']).optional().describe('Response detail level for /companies and /filings'),
});

type Input = z.infer<typeof InputSchema>;

function requireParam<K extends keyof Input>(input: Input, key: K, action: string): string | undefined {
  if (input[key] === undefined || input[key] === null) {
    return `${String(key)} is required for ${action}`;
  }
  return undefined;
}

// ============================================================================
// Action dispatch
// ============================================================================

async function executeAction(
  input: Input,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const { action } = input;

  switch (action) {
    // -------------------------------------------------------------- Companies
    case 'search_companies': {
      const err = requireParam(input, 'query', action);
      if (err) return formatToolResult({ error: err });
      onProgress?.(`Searching companies: "${input.query}"...`);
      const { data, url } = await withTimeout(
        frApi.get('/companies/', {
          search: input.query,
          countries: input.countries,
          page: input.page,
          page_size: input.page_size ?? 10,
          ordering: input.ordering,
          view: input.view ?? 'summary',
        }, { cacheable: true, ttlMs: TTL_15M }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    case 'get_company': {
      const err = requireParam(input, 'company_id', action);
      if (err) return formatToolResult({ error: err });
      onProgress?.(`Fetching company #${input.company_id}...`);
      const { data, url } = await withTimeout(
        frApi.get(`/companies/${input.company_id}/`, { view: input.view ?? 'full' }, { cacheable: true, ttlMs: TTL_6H }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    case 'get_financials': {
      const err = requireParam(input, 'company_id', action);
      if (err) return formatToolResult({ error: err });
      onProgress?.(`Fetching standardized financials for company #${input.company_id}...`);
      const { data, url } = await withTimeout(
        frApi.get(`/companies/${input.company_id}/financials/`, {
          statement_type: input.statement_type,
          fiscal_year: input.fiscal_year,
          fiscal_year_from: input.fiscal_year_from,
          fiscal_year_to: input.fiscal_year_to,
          fiscal_period: input.fiscal_period,
          line_items: input.line_items,
        }, { cacheable: true, ttlMs: TTL_6H }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    case 'get_next_annual_report': {
      const err = requireParam(input, 'company_id', action);
      if (err) return formatToolResult({ error: err });
      onProgress?.(`Fetching next-AR ETA for company #${input.company_id}...`);
      const { data, url } = await withTimeout(
        frApi.get(`/companies/${input.company_id}/next-annual-report/`, {}, { cacheable: true, ttlMs: TTL_6H }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    // ---------------------------------------------------------------- Filings
    case 'search_filings': {
      onProgress?.('Searching filings...');
      // Note: /filings/?search=... is currently broken (returns 0 for everything),
      // so we don't expose a `search` query here. Use search_companies → get_filings flow.
      const { data, url } = await withTimeout(
        frApi.get('/filings/', {
          countries: input.countries,
          type: input.filing_type,
          types: input.filing_types,
          category: input.filing_category,
          company: input.company_id,
          company_isin: input.company_isin,
          fiscal_year: input.fiscal_year,
          fiscal_period: input.fiscal_period,
          release_datetime_from: input.release_datetime_from,
          release_datetime_to: input.release_datetime_to,
          page: input.page,
          page_size: input.page_size ?? 20,
          ordering: input.ordering ?? '-release_datetime',
          view: input.view ?? 'summary',
        }, { cacheable: true, ttlMs: TTL_15M }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    case 'get_filing': {
      const err = requireParam(input, 'filing_id', action);
      if (err) return formatToolResult({ error: err });
      onProgress?.(`Fetching filing #${input.filing_id} detail...`);
      const { data, url } = await withTimeout(
        frApi.get(`/filings/${input.filing_id}/`, { view: input.view ?? 'full' }, { cacheable: true, ttlMs: TTL_1H }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    case 'read_filing': {
      const err = requireParam(input, 'filing_id', action);
      if (err) return formatToolResult({ error: err });
      onProgress?.(`Reading filing #${input.filing_id}...`);

      // Step 1: detail check — never trust /markdown/ blindly (~9-15% FAILED)
      const { data: detail, url: detailUrl } = await withTimeout(
        frApi.get(`/filings/${input.filing_id}/`, { view: 'full' }, { cacheable: true, ttlMs: TTL_1H }),
        TIMEOUT_MS,
        `${action}.detail`,
      );

      const status = typeof detail.processing_status === 'string' ? detail.processing_status : undefined;
      const documentUrl = typeof detail.document === 'string' ? detail.document : undefined;

      if (status !== 'COMPLETED') {
        return formatToolResult({
          filing: detail,
          processing_status: status ?? 'UNKNOWN',
          markdown_available: false,
          raw_document_url: documentUrl,
          note: documentUrl
            ? 'Markdown not available (processing not COMPLETED). Pipe raw_document_url through web_fetch to retrieve HTML, or surface the URL to the user for PDF/XBRL.'
            : 'Markdown not available and no raw document URL on record. Try get_filing_history for context on the failure.',
        }, [detailUrl]);
      }

      // Step 2: markdown fetch (long TTL — markdown for processed filings is immutable)
      const { data: md, url: mdUrl } = await withTimeout(
        frApi.get(`/filings/${input.filing_id}/markdown/`, {}, { cacheable: true, ttlMs: TTL_24H }),
        TIMEOUT_MS,
        `${action}.markdown`,
      );

      return formatToolResult({
        filing: detail,
        markdown_available: true,
        markdown: md,
      }, [mdUrl, detailUrl]);
    }

    case 'get_filing_history': {
      const err = requireParam(input, 'filing_id', action);
      if (err) return formatToolResult({ error: err });
      onProgress?.(`Fetching audit trail for filing #${input.filing_id}...`);
      const { data, url } = await withTimeout(
        frApi.get(`/filings/${input.filing_id}/history/`, {}, { cacheable: true, ttlMs: TTL_1H }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    // -------------------------------------------------- Identifiers / taxonomy
    case 'resolve_isin': {
      const err = requireParam(input, 'company_isin', action);
      if (err) return formatToolResult({ error: err });
      onProgress?.(`Resolving ISIN ${input.company_isin}...`);
      const { data, url } = await withTimeout(
        frApi.get(`/isins/${input.company_isin}/`, {}, { cacheable: true, ttlMs: TTL_24H }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    case 'list_line_items': {
      onProgress?.('Listing line-item definitions...');
      const { data, url } = await withTimeout(
        frApi.get('/line-item-definitions/', { page_size: input.page_size ?? 200 }, { cacheable: true, ttlMs: TTL_24H }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    // ----------------------------------------------------------- Reference
    case 'list_countries': {
      onProgress?.('Listing countries...');
      const { data, url } = await withTimeout(
        frApi.get('/countries/', { page_size: input.page_size ?? 100 }, { cacheable: true, ttlMs: TTL_24H }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    case 'list_filing_types': {
      onProgress?.('Listing filing types...');
      const { data, url } = await withTimeout(
        frApi.get('/filing-types/', { page_size: input.page_size ?? 100 }, { cacheable: true, ttlMs: TTL_24H }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    case 'list_filing_categories': {
      onProgress?.('Listing filing categories...');
      const { data, url } = await withTimeout(
        frApi.get('/filing-categories/', { page_size: input.page_size ?? 100 }, { cacheable: true, ttlMs: TTL_24H }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    case 'list_sources': {
      onProgress?.('Listing sources...');
      const { data, url } = await withTimeout(
        frApi.get('/sources/', { page_size: input.page_size ?? 100 }, { cacheable: true, ttlMs: TTL_24H }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    // ---------------------------------------------------------- Watchlist
    case 'get_watchlist': {
      onProgress?.('Fetching watchlist...');
      const { data, url } = await withTimeout(
        frApi.get('/watchlist/', { page_size: input.page_size ?? 100 }, { cacheable: false }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    case 'add_to_watchlist': {
      const err = requireParam(input, 'company_id', action);
      if (err) return formatToolResult({ error: err });
      onProgress?.(`Adding company #${input.company_id} to watchlist...`);
      const { data, url } = await withTimeout(
        frApi.post('/watchlist/companies/', { company_id: input.company_id }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    case 'remove_from_watchlist': {
      const err = requireParam(input, 'company_id', action);
      if (err) return formatToolResult({ error: err });
      onProgress?.(`Removing company #${input.company_id} from watchlist...`);
      const { data, url } = await withTimeout(
        frApi.del(`/watchlist/companies/${input.company_id}/`),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    case 'bulk_watchlist': {
      if (!input.company_ids || input.company_ids.length === 0) {
        return formatToolResult({ error: 'company_ids (non-empty array) is required for bulk_watchlist' });
      }
      const op = input.watchlist_action ?? 'add';
      const endpoint = op === 'remove' ? '/watchlist/companies/bulk-remove/' : '/watchlist/companies/bulk-add/';
      onProgress?.(`Bulk ${op} ${input.company_ids.length} companies on watchlist...`);
      const { data, url } = await withTimeout(
        frApi.post(endpoint, { company_ids: input.company_ids }),
        TIMEOUT_MS,
        action,
      );
      return formatToolResult(data, [url]);
    }

    default: {
      const _exhaustive: never = action;
      return formatToolResult({ error: `Unknown action: ${String(_exhaustive)}` });
    }
  }
}

// ============================================================================
// Tool factory
// ============================================================================

export function createFrResearch(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'fr_research',
    description: `Unified financial research tool backed by FinancialReports.eu (sole data source). Companies, filings (with markdown + raw fallback), standardized financials, ISIN resolution, audit trails, watchlist. G20 coverage. ~46K companies, 20M+ filings.`,
    schema: InputSchema,
    func: async (input: Input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
      try {
        return await executeAction(input, onProgress);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[fr_research] ${input.action} failed: ${message}`);
        return formatToolResult({
          error: `${input.action} failed`,
          details: message,
        });
      }
    },
  });
}

// ============================================================================
// Backward-compat shims (legacy name)
// ============================================================================

export const FINANCIAL_REPORTS_DESCRIPTION = FR_RESEARCH_DESCRIPTION;
export const createFinancialReports = createFrResearch;
