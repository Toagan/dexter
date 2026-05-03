import { describe, test, expect } from 'bun:test';
import { createFrResearch } from './financial-reports.js';

// Integration tests — require FINANCIAL_REPORTS_API_KEY in env.
// FR endpoints can be slow (5-30s on cold cache); generous per-test timeout.
const TEST_TIMEOUT_MS = 30_000;

const hasKey = !!process.env.FINANCIAL_REPORTS_API_KEY;
const describeIfKey = hasKey ? describe : describe.skip;

describeIfKey('fr_research tool (integration)', () => {
  const tool = createFrResearch();

  test('search_companies finds Siemens', async () => {
    const raw = await tool.invoke({ action: 'search_companies', query: 'Siemens' });
    const result = JSON.parse(raw);
    expect(result.data.results).toBeDefined();
    expect(result.data.results.length).toBeGreaterThan(0);
    expect(result.data.results[0].name).toContain('Siemens');
    console.log(`  Found ${result.data.count} companies`);
  }, TEST_TIMEOUT_MS);

  test('get_company returns Siemens AG details', async () => {
    const raw = await tool.invoke({ action: 'get_company', company_id: 390 });
    const result = JSON.parse(raw);
    expect(result.data.name).toBe('Siemens AG');
    expect(result.data.country_code).toBe('DE');
    console.log(`  Company: ${result.data.name} (${result.data.country_code})`);
  }, TEST_TIMEOUT_MS);

  test('search_filings filtered by company_id', async () => {
    const raw = await tool.invoke({ action: 'search_filings', company_id: 390, page_size: 3 });
    const result = JSON.parse(raw);
    expect(result.data.results).toBeDefined();
    expect(result.data.results.length).toBeGreaterThan(0);
    console.log(`  Found ${result.data.count} filings, showing ${result.data.results.length}`);
  }, TEST_TIMEOUT_MS);

  test('search_filings with countries (plural) filter', async () => {
    const raw = await tool.invoke({ action: 'search_filings', countries: 'DE', page_size: 3 });
    const result = JSON.parse(raw);
    expect(result.data.results).toBeDefined();
    expect(result.data.results.length).toBeGreaterThan(0);
    console.log(`  Found ${result.data.count} German filings`);
  }, TEST_TIMEOUT_MS);

  test('get_filing returns detail (incl. document URL)', async () => {
    const listRaw = await tool.invoke({ action: 'search_filings', company_id: 390, page_size: 1 });
    const listResult = JSON.parse(listRaw);
    const filingId = listResult.data.results[0].id;

    const raw = await tool.invoke({ action: 'get_filing', filing_id: filingId });
    const result = JSON.parse(raw);
    expect(result.data).toBeDefined();
    expect(typeof result.data).toBe('object');
    // processing_status may be undefined for some access tiers — read_filing has a fallback.
    // Document URL is what we actually need for raw fallback.
    const hasDocUrl = typeof result.data.document === 'string' && result.data.document.length > 0;
    expect(hasDocUrl).toBe(true);
    console.log(`  Filing #${filingId} status=${result.data.processing_status ?? '(absent)'} document=${hasDocUrl ? 'present' : 'absent'}`);
  }, TEST_TIMEOUT_MS);

  test('read_filing returns markdown OR raw_document_url fallback', async () => {
    const listRaw = await tool.invoke({ action: 'search_filings', company_id: 390, page_size: 1 });
    const listResult = JSON.parse(listRaw);
    const filingId = listResult.data.results[0].id;

    const raw = await tool.invoke({ action: 'read_filing', filing_id: filingId });
    const result = JSON.parse(raw);
    expect(result.data).toBeDefined();
    if (result.data.markdown_available) {
      expect(result.data.markdown).toBeDefined();
      console.log(`  Read markdown for filing #${filingId}, ${JSON.stringify(result.data.markdown).length} chars`);
    } else {
      // Fallback path: must surface either the processing status or the raw URL
      const hasFallback =
        typeof result.data.processing_status === 'string' ||
        typeof result.data.raw_document_url === 'string';
      expect(hasFallback).toBe(true);
      console.log(`  Filing #${filingId} not COMPLETED (${result.data.processing_status}); raw_document_url=${result.data.raw_document_url ? 'present' : 'absent'}`);
    }
  }, TEST_TIMEOUT_MS);

  test('list_countries returns countries', async () => {
    const raw = await tool.invoke({ action: 'list_countries' });
    const result = JSON.parse(raw);
    expect(result.data.results).toBeDefined();
    expect(result.data.results.length).toBeGreaterThanOrEqual(100);
    console.log(`  Found ${result.data.count} countries`);
  }, TEST_TIMEOUT_MS);

  test('list_filing_types returns types', async () => {
    const raw = await tool.invoke({ action: 'list_filing_types' });
    const result = JSON.parse(raw);
    expect(result.data.results).toBeDefined();
    expect(result.data.results.length).toBeGreaterThan(0);
    console.log(`  Found ${result.data.count} filing types`);
  }, TEST_TIMEOUT_MS);

  test('list_line_items endpoint responds (KPI taxonomy may be tier-gated)', async () => {
    const raw = await tool.invoke({ action: 'list_line_items' });
    const result = JSON.parse(raw);
    // Some access tiers return an empty taxonomy. Just verify the call succeeded
    // and returned a structured response of either shape (paginated or flat array).
    expect(result.data).toBeDefined();
    const items = Array.isArray(result.data)
      ? result.data
      : (result.data.results ?? []);
    expect(Array.isArray(items)).toBe(true);
    const shape = Array.isArray(result.data) ? 'array' : 'paginated';
    console.log(`  list_line_items: ${items.length} definitions (shape: ${shape})${items.length === 0 ? ' — likely tier-gated for this key' : ''}`);
  }, TEST_TIMEOUT_MS);

  test('returns error for missing required params', async () => {
    const raw = await tool.invoke({ action: 'get_company' });
    const result = JSON.parse(raw);
    expect(result.data.error).toContain('company_id is required');
  });

  test('schema rejects unknown actions', async () => {
    let threw = false;
    try {
      await tool.invoke({ action: 'definitely_not_an_action' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
