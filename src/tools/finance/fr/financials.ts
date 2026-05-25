import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { frApi } from './api.js';
import { resolveCompany } from './companies.js';
import { formatToolResult } from '../../types.js';
import { TTL_6H } from '../utils.js';

export const GET_GLOBAL_FINANCIALS_DESCRIPTION = `
Retrieves standardized financial statements for public companies WORLDWIDE via FinancialReports.eu — Capital-IQ-grade line items for non-US companies the US-only get_financials tool cannot cover.

## When to Use

- Income statement / balance sheet / cash-flow data for a European, Asian, or LATAM listed company
- When the company is best identified by ISIN rather than a US ticker
- Standardized, deduplicated line items (each tagged with hierarchy and a Capital-IQ-standard flag) across fiscal periods

## When NOT to Use

- US companies where a ticker is known (get_financials is faster and richer for US filers)
- Ratios/valuation snapshots, prices, or estimates (FR returns reported statements, not derived metrics or market data)

## Usage Notes

- Provide an ISIN when you have one (exact); otherwise the company name.
- Values are in the company's REPORTING CURRENCY — always display the currency code and never
  aggregate across currencies without explicit conversion.
- Always show the fiscal period and period_end_date alongside figures; do not silently mix FY/quarters.
`.trim();

const GetGlobalFinancialsInputSchema = z.object({
  company_name: z
    .string()
    .optional()
    .describe("Company name to resolve, e.g. 'ASML'. Provide this OR isin."),
  isin: z
    .string()
    .optional()
    .describe("ISIN to resolve, e.g. 'NL0010273215'. Exact match — preferred when known."),
});

export const getGlobalFinancials = new DynamicStructuredTool({
  name: 'get_global_financials',
  description: `Retrieves standardized financial statements (income statement, balance sheet, cash flow) for public companies worldwide (incl. non-US) via FinancialReports.eu. Resolve by company name or ISIN. Values are in reporting currency — always show the currency and fiscal period.`,
  schema: GetGlobalFinancialsInputSchema,
  func: async (input) => {
    if (!input.company_name && !input.isin) {
      return formatToolResult({ error: 'Provide either company_name or isin.' }, []);
    }

    const company = await resolveCompany({ isin: input.isin, name: input.company_name });
    if (!company) {
      return formatToolResult(
        { error: `No FinancialReports company matched ${input.isin ?? input.company_name}.` },
        [],
      );
    }

    const { data, url } = await frApi.get(
      `/companies/${company.id}/financials/`,
      {},
      { cacheable: true, ttlMs: TTL_6H },
    );
    return formatToolResult({ company: { id: company.id, name: company.name }, financials: data }, [url]);
  },
});
