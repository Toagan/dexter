import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { frApi } from './api.js';
import { formatToolResult } from '../../types.js';
import { TTL_24H } from '../utils.js';

export const READ_GLOBAL_FILING_DESCRIPTION = `
Reads the AI-extracted text (markdown) of a specific worldwide filing via FinancialReports.eu — the international counterpart to read_filings, covering non-US annual/interim/earnings reports in many languages.

## When to Use

- Reading the content of a non-US filing (annual report, interim report, earnings release) after
  finding it with get_global_filings
- Extracting narrative, MD&A-equivalent sections, or disclosures from a European/Asian/LATAM filer

## When NOT to Use

- US 10-K/10-Q/8-K item-level reading (use read_filings — it does SEC item selection)
- Structured financial line items (use get_global_financials)

## Usage Notes

- Requires an FR filing id, obtained from get_global_filings.
- Extraction is not guaranteed: ~9-15% of filings have processing_status FAILED (terminal,
  commonly scanned PDFs / non-Latin scripts). This tool checks status first and, when extraction
  failed, returns the raw source document URL so you can fall back to web_fetch.
`.trim();

const ReadGlobalFilingInputSchema = z.object({
  filing_id: z
    .union([z.string(), z.number()])
    .describe('The FR filing id, obtained from get_global_filings.'),
});

export const readGlobalFiling = new DynamicStructuredTool({
  name: 'read_global_filing',
  description: `Reads the AI-extracted markdown text of a specific worldwide (incl. non-US) filing via FinancialReports.eu. Requires an FR filing id from get_global_filings. Falls back to the raw document URL when extraction failed.`,
  schema: ReadGlobalFilingInputSchema,
  func: async (input) => {
    const id = String(input.filing_id);

    // Check extraction status before fetching markdown — FAILED is terminal and
    // /markdown/ would error or return nothing.
    const { data: detail, url: detailUrl } = await frApi.get(
      `/filings/${id}/`,
      {},
      { cacheable: true, ttlMs: TTL_24H },
    );
    const status = String((detail as { processing_status?: unknown }).processing_status ?? '').toUpperCase();

    if (status && status !== 'COMPLETED') {
      const documentUrl =
        (detail as { document?: string }).document ??
        (detail as { document_url?: string }).document_url ??
        null;
      return formatToolResult(
        {
          filing_id: id,
          processing_status: status,
          note: 'Markdown extraction not available. Use web_fetch on document_url to read the source.',
          document_url: documentUrl,
        },
        [detailUrl],
      );
    }

    // The markdown endpoint returns a raw text/markdown body, not a JSON envelope.
    const { text, url } = await frApi.getText(`/filings/${id}/markdown/`);
    return formatToolResult({ filing_id: id, processing_status: status || 'COMPLETED', markdown: text }, [url]);
  },
});
