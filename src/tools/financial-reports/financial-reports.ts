import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { frApi } from './api.js';
import { withTimeout } from '../finance/utils.js';
import { logger } from '../../utils/logger.js';

const TIMEOUT_MS = 30_000;

/**
 * Rich description for the financial_reports tool.
 * Used in the system prompt to guide the LLM on when and how to use this tool.
 */
export const FINANCIAL_REPORTS_DESCRIPTION = `
Search and read financial reports from FinancialReports.eu — a global database of company filings including annual reports, 20-F, and other regulatory filings, with strong coverage of European, Asian, and emerging market companies.

## When to Use

- Searching for annual reports or financial filings of **non-US** companies (European, Asian, etc.)
- Looking up financial filings by company name across global markets
- Reading the full text (markdown) of a specific filing
- Finding companies by name, country, or industry (ISIC classification)
- Getting filing history for a company over time
- Researching companies not well covered by SEC/US-centric data sources

## When NOT to Use

- US company SEC filings (10-K, 10-Q, 8-K) — use read_filings instead
- Structured financial statement data (income statement, balance sheet) — use get_financials
- Stock prices or market data — use get_market_data
- Real-time news — use web_search

## Usage Notes

- Use action "search_companies" first to find a company and its ID
- Then use "get_filings" with the company_id to list available filings
- Use "read_filing" with a filing ID to get the full text content in markdown
- The "search_filings" action searches across all filings with optional filters
- Country codes are ISO 3166-1 alpha-2 (e.g., DE, FR, JP, GB, CN)
`.trim();

const ActionSchema = z.enum([
  'search_companies',
  'get_company',
  'search_filings',
  'get_filings',
  'read_filing',
  'list_countries',
  'list_filing_types',
]);

const InputSchema = z.object({
  action: ActionSchema.describe(
    'The action to perform: search_companies, get_company, search_filings, get_filings, read_filing, list_countries, list_filing_types'
  ),
  query: z
    .string()
    .optional()
    .describe('Search query for company name (used with search_companies)'),
  company_id: z
    .number()
    .optional()
    .describe('Company ID (used with get_company, get_filings)'),
  filing_id: z
    .number()
    .optional()
    .describe('Filing ID (used with read_filing)'),
  country: z
    .string()
    .optional()
    .describe('ISO country code filter, e.g. DE, FR, JP (used with search_filings, get_filings)'),
  filing_type: z
    .string()
    .optional()
    .describe('Filing type filter, e.g. annual-report, 20-F (used with search_filings, get_filings)'),
  page: z
    .number()
    .optional()
    .describe('Page number for paginated results (default 1)'),
  page_size: z
    .number()
    .optional()
    .describe('Results per page (default 10, max 100)'),
});

type Input = z.infer<typeof InputSchema>;

async function executeAction(
  input: Input,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const { action } = input;

  switch (action) {
    case 'search_companies': {
      if (!input.query) {
        return formatToolResult({ error: 'query is required for search_companies' });
      }
      onProgress?.(`Searching companies: "${input.query}"...`);
      const { data, url } = await withTimeout(
        frApi.get('/companies/', {
          search: input.query,
          page: input.page,
          page_size: input.page_size || 10,
        }, { cacheable: true, ttlMs: 60_000 }),
        TIMEOUT_MS,
        'search_companies',
      );
      return formatToolResult(data, [url]);
    }

    case 'get_company': {
      if (!input.company_id) {
        return formatToolResult({ error: 'company_id is required for get_company' });
      }
      onProgress?.(`Fetching company #${input.company_id}...`);
      const { data, url } = await withTimeout(
        frApi.get(`/companies/${input.company_id}/`, {}, { cacheable: true, ttlMs: 300_000 }),
        TIMEOUT_MS,
        'get_company',
      );
      return formatToolResult(data, [url]);
    }

    case 'search_filings': {
      onProgress?.('Searching filings...');
      const params: Record<string, string | number | undefined> = {
        page: input.page,
        page_size: input.page_size || 10,
      };
      if (input.country) params.countries = input.country;
      if (input.filing_type) params.types = input.filing_type;
      if (input.company_id) params.company = input.company_id;

      const { data, url } = await withTimeout(
        frApi.get('/filings/', params, { cacheable: true, ttlMs: 60_000 }),
        TIMEOUT_MS,
        'search_filings',
      );
      return formatToolResult(data, [url]);
    }

    case 'get_filings': {
      if (!input.company_id) {
        return formatToolResult({ error: 'company_id is required for get_filings' });
      }
      onProgress?.(`Fetching filings for company #${input.company_id}...`);
      const params: Record<string, string | number | undefined> = {
        company: input.company_id,
        page: input.page,
        page_size: input.page_size || 20,
      };
      if (input.country) params.countries = input.country;
      if (input.filing_type) params.types = input.filing_type;

      const { data, url } = await withTimeout(
        frApi.get('/filings/', params, { cacheable: true, ttlMs: 60_000 }),
        TIMEOUT_MS,
        'get_filings',
      );
      return formatToolResult(data, [url]);
    }

    case 'read_filing': {
      if (!input.filing_id) {
        return formatToolResult({ error: 'filing_id is required for read_filing' });
      }
      onProgress?.(`Reading filing #${input.filing_id} content...`);
      const { data, url } = await withTimeout(
        frApi.get(`/filings/${input.filing_id}/markdown/`, {}, { cacheable: true, ttlMs: 3_600_000 }),
        TIMEOUT_MS,
        'read_filing',
      );
      return formatToolResult(data, [url]);
    }

    case 'list_countries': {
      onProgress?.('Listing available countries...');
      const { data, url } = await withTimeout(
        frApi.get('/countries/', { page_size: 100 }, { cacheable: true, ttlMs: 86_400_000 }),
        TIMEOUT_MS,
        'list_countries',
      );
      return formatToolResult(data, [url]);
    }

    case 'list_filing_types': {
      onProgress?.('Listing filing types...');
      const { data, url } = await withTimeout(
        frApi.get('/filing-types/', { page_size: 100 }, { cacheable: true, ttlMs: 86_400_000 }),
        TIMEOUT_MS,
        'list_filing_types',
      );
      return formatToolResult(data, [url]);
    }

    default:
      return formatToolResult({ error: `Unknown action: ${action}` });
  }
}

export function createFinancialReports(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'financial_reports',
    description: `Search and read global financial reports from FinancialReports.eu. Covers annual reports, 20-F filings, and regulatory filings for companies worldwide — especially strong for non-US/European companies. Actions: search_companies, get_company, search_filings, get_filings, read_filing, list_countries, list_filing_types.`,
    schema: InputSchema,
    func: async (input: Input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;
      try {
        return await executeAction(input, onProgress);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[financial_reports] ${input.action} failed: ${message}`);
        return formatToolResult({
          error: `${input.action} failed`,
          details: message,
        });
      }
    },
  });
}
