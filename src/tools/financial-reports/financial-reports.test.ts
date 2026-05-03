import { describe, test, expect } from 'bun:test';
import { createFinancialReports } from './financial-reports.js';

// Integration tests — require FINANCIAL_REPORTS_API_KEY in env
const hasKey = !!process.env.FINANCIAL_REPORTS_API_KEY;
const describeIfKey = hasKey ? describe : describe.skip;

describeIfKey('financial_reports tool (integration)', () => {
  const tool = createFinancialReports();

  test('search_companies finds Siemens', async () => {
    const raw = await tool.invoke({ action: 'search_companies', query: 'Siemens' });
    const result = JSON.parse(raw);
    expect(result.data.results).toBeDefined();
    expect(result.data.results.length).toBeGreaterThan(0);
    expect(result.data.results[0].name).toContain('Siemens');
    console.log(`  Found ${result.data.count} companies`);
  });

  test('get_company returns Siemens AG details', async () => {
    const raw = await tool.invoke({ action: 'get_company', company_id: 390 });
    const result = JSON.parse(raw);
    expect(result.data.name).toBe('Siemens AG');
    expect(result.data.country_code).toBe('DE');
    console.log(`  Company: ${result.data.name} (${result.data.country_code})`);
  });

  test('get_filings returns filings for Siemens', async () => {
    const raw = await tool.invoke({ action: 'get_filings', company_id: 390, page_size: 3 });
    const result = JSON.parse(raw);
    expect(result.data.results).toBeDefined();
    expect(result.data.results.length).toBeGreaterThan(0);
    console.log(`  Found ${result.data.count} filings, showing ${result.data.results.length}`);
  });

  test('search_filings with country filter', async () => {
    const raw = await tool.invoke({ action: 'search_filings', country: 'DE', page_size: 3 });
    const result = JSON.parse(raw);
    expect(result.data.results).toBeDefined();
    expect(result.data.results.length).toBeGreaterThan(0);
    console.log(`  Found ${result.data.count} German filings`);
  });

  test('read_filing returns markdown content', async () => {
    // First get a filing ID
    const listRaw = await tool.invoke({ action: 'get_filings', company_id: 390, page_size: 1 });
    const listResult = JSON.parse(listRaw);
    const filingId = listResult.data.results[0].id;

    const raw = await tool.invoke({ action: 'read_filing', filing_id: filingId });
    const result = JSON.parse(raw);
    expect(result.data).toBeDefined();
    console.log(`  Read filing #${filingId}, content length: ${JSON.stringify(result.data).length} chars`);
  });

  test('list_countries returns countries', async () => {
    const raw = await tool.invoke({ action: 'list_countries' });
    const result = JSON.parse(raw);
    expect(result.data.results).toBeDefined();
    expect(result.data.results.length).toBeGreaterThanOrEqual(100);
    console.log(`  Found ${result.data.count} countries`);
  });

  test('list_filing_types returns types', async () => {
    const raw = await tool.invoke({ action: 'list_filing_types' });
    const result = JSON.parse(raw);
    expect(result.data.results).toBeDefined();
    expect(result.data.results.length).toBeGreaterThan(0);
    console.log(`  Found ${result.data.count} filing types`);
  });

  test('returns error for missing required params', async () => {
    const raw = await tool.invoke({ action: 'get_company' });
    const result = JSON.parse(raw);
    expect(result.data.error).toContain('company_id is required');
  });
});
