/**
 * Direct fr_research smoke — bypasses the LLM, exercises the FR tool surface
 * end-to-end against the live FinancialReports.eu API.
 *
 * Use this when you don't have an LLM key configured (or when you just want
 * to verify the FR-only data layer is healthy).
 */
import 'dotenv/config';
import { createFrResearch } from '../src/tools/financial-reports/index.js';

const TARGET = (process.argv.slice(2).join(' ').trim()) || 'ASML';

function parse(raw: string): any {
  try { return JSON.parse(raw); } catch { return { raw }; }
}

function preview(obj: unknown, max = 240): string {
  return JSON.stringify(obj).slice(0, max);
}

async function main() {
  const t0 = Date.now();
  console.log(`[smoke] target=${TARGET}`);
  if (!process.env.FINANCIAL_REPORTS_API_KEY) {
    console.error('FINANCIAL_REPORTS_API_KEY missing in .env'); process.exit(1);
  }

  const tool = createFrResearch();
  const call = (args: Record<string, unknown>) => tool.invoke(args).then(parse);

  // 1. Resolve company
  console.log('\n[1] search_companies');
  const search = await call({ action: 'search_companies', query: TARGET, page_size: 3 });
  const companies = search?.data?.results ?? [];
  if (!companies.length) { console.error('No companies found'); process.exit(1); }
  const company = companies[0];
  console.log(`    → ${company.name} (id=${company.id}, country=${company.country_code})`);

  // 2. Company detail (full view)
  console.log('\n[2] get_company');
  const detail = await call({ action: 'get_company', company_id: company.id, view: 'full' });
  const c = detail?.data ?? {};
  console.log(`    name=${c.name} sector=${c.sector ?? '?'} ipo=${c.date_ipo ?? '?'} ticker=${c.primary_ticker ?? '?'} ISIN=${c.primary_isin ?? '?'}`);

  // 3. Standardized financials (L3)
  console.log('\n[3] get_financials (L3)');
  const fin = await call({ action: 'get_financials', company_id: company.id, statement_type: 'IS', fiscal_period: 'FY' });
  const finData = fin?.data;
  if (Array.isArray(finData)) {
    console.log(`    → ${finData.length} statements (flat array)`);
  } else if (finData?.results) {
    console.log(`    → ${finData.results.length} statements (paginated)`);
  } else {
    console.log(`    → response shape: ${preview(finData)}`);
  }

  // 4. Recent filings
  console.log('\n[4] search_filings (most recent 3)');
  const filings = await call({ action: 'search_filings', company_id: company.id, page_size: 3 });
  const list = filings?.data?.results ?? [];
  list.forEach((f: any, i: number) => {
    console.log(`    ${i + 1}. id=${f.id} type=${f.filing_type ?? f.type ?? '?'} period=${f.fiscal_period ?? '?'}/${f.fiscal_year ?? '?'} released=${f.release_datetime?.slice(0, 10) ?? f.release_date ?? '?'}`);
    console.log(`       ${(f.title ?? f.document_title ?? '').slice(0, 100)}`);
  });

  // 5. Read filing (markdown OR raw fallback)
  if (list.length > 0) {
    const filingId = list[0].id;
    console.log(`\n[5] read_filing #${filingId}`);
    const read = await call({ action: 'read_filing', filing_id: filingId });
    const rd = read?.data ?? {};
    if (rd.markdown_available) {
      const mdLen = JSON.stringify(rd.markdown).length;
      console.log(`    → markdown available (${mdLen.toLocaleString()} chars)`);
    } else {
      console.log(`    → markdown NOT available (status=${rd.processing_status})`);
      console.log(`      raw_document_url: ${rd.raw_document_url ?? '(absent)'}`);
      console.log(`      → fallback path: pipe URL through web_fetch tool`);
    }
  }

  // 6. Next annual report ETA
  console.log('\n[6] get_next_annual_report');
  const next = await call({ action: 'get_next_annual_report', company_id: company.id });
  const n = next?.data ?? {};
  console.log(`    → window=${n.start_date ?? '?'} to ${n.end_date ?? '?'} (confidence=${n.confidence ?? '?'})`);

  console.log(`\n[smoke] elapsed=${Date.now() - t0}ms`);
}

main().catch((err) => {
  console.error('[smoke] failed:', err);
  process.exit(1);
});
