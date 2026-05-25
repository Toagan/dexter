import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { frApi } from './api.js';
import { resolveCompany } from './companies.js';
import { formatToolResult } from '../../types.js';
import { TTL_1H } from '../utils.js';

export const GET_GLOBAL_FILINGS_DESCRIPTION = `
Retrieves regulatory filing metadata for public companies WORLDWIDE via FinancialReports.eu — including non-US markets (Europe, APAC, LATAM) that the US-only get_filings tool cannot reach.

## When to Use

- Listing filings for a European, Asian, or LATAM listed company (e.g. ASML, Bayer, Toyota, Samsung, Petrobras)
- Resolving a company by ISIN (e.g. NL0010273215) rather than a US ticker
- Annual / interim / earnings reports filed with non-SEC regulators (BaFin, AMF, EDINET, OpenDART, FSA UK, etc.)

## When NOT to Use

- US-only companies where a SEC ticker is known and 10-K/10-Q/8-K item-level text is needed (use get_filings / read_filings)
- Stock prices, news, insider trades (use get_market_data — FR does not provide these)

## Usage Notes

- Provide an ISIN when you have one (exact match); otherwise provide the company name.
- Returns metadata only (filing id, type, period, release date, document URL). To read the
  extracted text of a specific filing, pass its filing id to read_global_filing.
- filing_type is an FR code: common ones are 10-K (annual), 10-K-ESEF (EU annual), IR (interim
  report), ER (earnings release), RNS (UK regulatory news). Omit to get the most recent of any type.
`.trim();

const GetGlobalFilingsInputSchema = z.object({
  company_name: z
    .string()
    .optional()
    .describe("Company name to resolve, e.g. 'ASML' or 'Bayer'. Provide this OR isin."),
  isin: z
    .string()
    .optional()
    .describe("ISIN to resolve, e.g. 'NL0010273215'. Exact match — preferred over company_name when known."),
  filing_type: z
    .string()
    .optional()
    .describe("Optional FR filing-type code to filter by: 10-K, 10-K-ESEF, IR, ER, RNS, 10-Q. Omit for most recent of any type."),
  countries: z
    .string()
    .optional()
    .describe("Optional comma-separated ISO 3166 alpha-2 country codes, e.g. 'DE,FR,JP'."),
  fiscal_year: z
    .number()
    .optional()
    .describe('Optional fiscal year filter (only populated for 10-K, 10-K-ESEF, IR, ER).'),
  limit: z
    .number()
    .default(10)
    .describe('Maximum filings to return (default 10).'),
});

export const getGlobalFilings = new DynamicStructuredTool({
  name: 'get_global_filings',
  description: `Retrieves regulatory filing metadata for public companies worldwide (incl. non-US) via FinancialReports.eu. Resolve by company name or ISIN. Returns filing metadata only — use read_global_filing to read a filing's text.`,
  schema: GetGlobalFilingsInputSchema,
  func: async (input) => {
    if (!input.company_name && !input.isin) {
      return formatToolResult({ error: 'Provide either company_name or isin.' }, []);
    }

    // RULE 1: resolve the company to an FR-internal id first. FR `search` is broken
    // on /filings/, so we must filter filings by the resolved company id.
    const company = await resolveCompany({ isin: input.isin, name: input.company_name });
    if (!company) {
      return formatToolResult(
        { error: `No FinancialReports company matched ${input.isin ?? input.company_name}.` },
        [],
      );
    }

    const params: Record<string, string | number | undefined> = {
      company: company.id,
      ordering: '-release_datetime',
      page_size: input.limit,
    };
    // Bug guard: combining `search` + `type` 500s at default page sizes. We never
    // pass `search` here (resolved by company id), so `type` is safe to apply.
    if (input.filing_type) params.type = input.filing_type;
    if (input.countries) params.countries = input.countries;
    if (input.fiscal_year) params.fiscal_year = input.fiscal_year;

    const { data, url } = await frApi.get('/filings/', params, { cacheable: true, ttlMs: TTL_1H });
    const results = (data as { results?: unknown[] }).results ?? data;
    return formatToolResult({ company: { id: company.id, name: company.name }, filings: results }, [url]);
  },
});
