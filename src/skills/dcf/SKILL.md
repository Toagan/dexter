---
name: dcf-valuation
description: Performs discounted cash flow (DCF) valuation analysis to estimate intrinsic value per share. Triggers when user asks for fair value, intrinsic value, DCF, valuation, "what is X worth", price target, undervalued/overvalued analysis, or wants to compare current price to fundamental value.
---

# DCF Valuation Skill (FR-only build)

In this build of Dexter, FinancialReports.eu (`fr_research`) is the sole source of structured financial data. Live quotes and analyst estimates are obtained via `web_search` / `web_fetch`.

## Workflow Checklist

Copy and track progress:
```
DCF Analysis Progress:
- [ ] Step 1: Resolve company on FR
- [ ] Step 2: Gather standardized financials (BS / IS / CFS)
- [ ] Step 3: Calculate FCF growth rate
- [ ] Step 4: Estimate discount rate (WACC)
- [ ] Step 5: Project future cash flows (Years 1-5 + Terminal)
- [ ] Step 6: Calculate present value and fair value per share
- [ ] Step 7: Fetch current price (web)
- [ ] Step 8: Run sensitivity analysis
- [ ] Step 9: Validate results
- [ ] Step 10: Present results with caveats
```

## Step 1: Resolve company on FR

Call `fr_research` with `action="search_companies"`:

**Args:** `{ action: "search_companies", query: "<company name or ticker>" }`

**Extract:** `company_id`, `name`, `country_code`, `sector`, `industry`

If the user supplied an ISIN, use `action="resolve_isin"` instead with `company_isin=<ISIN>`.

## Step 2: Gather Standardized Financials

FR returns Capital-IQ-grade line items keyed by the 126 standard codes — no schema variance across geographies.

### 2.1 Cash Flow History (5 years)

`{ action: "get_financials", company_id, statement_type: "CFS", fiscal_year_from: <currentYear-5>, fiscal_period: "FY" }`

**Extract per period:** `free_cash_flow`, `net_cash_flow_from_operations`, `capital_expenditure`

**Fallback:** if `free_cash_flow` missing, calculate `net_cash_flow_from_operations - capital_expenditure`.

### 2.2 Income Statement (5 years)

`{ action: "get_financials", company_id, statement_type: "IS", fiscal_year_from: <currentYear-5>, fiscal_period: "FY" }`

**Extract per period:** `revenue`, `ebitda`, `operating_income`, `net_income_loss`

**Use:** revenue growth as cross-check on FCF growth.

### 2.3 Balance Sheet (latest)

`{ action: "get_financials", company_id, statement_type: "BS", fiscal_year_from: <currentYear-1>, fiscal_period: "FY" }`

**Extract:** `total_debt` (or `long_term_debt + short_term_debt`), `cash_and_equivalents`, `current_investments`, `outstanding_shares` (also available on `get_company`).

**Fallback:** if `current_investments` missing, use 0. If `outstanding_shares` missing on the BS, fetch from `{ action: "get_company", company_id, view: "full" }`.

### 2.4 Company facts (sector / industry / market cap)

`{ action: "get_company", company_id, view: "full" }`

**Extract:** `sector`, `industry`, `market_cap`, `country_code`, `primary_isin`, `primary_ticker`, `currency`.

**Use:** sector → WACC range from [sector-wacc.md](sector-wacc.md). Note `currency` so the final number is reported in the same unit as the financials.

## Step 3: Calculate FCF Growth Rate

5-year FCF CAGR from cash-flow history.

**Cross-validate with:** revenue growth from Step 2.2.

**Growth rate selection:**
- Stable FCF history → use CAGR with 10–20% haircut
- Volatile FCF → use 3-year median growth, weight conservatively
- **Cap at 15%** (sustained higher growth is rare)

Note: **No analyst-estimate cross-check available** in this build (FR does not surface consensus). If you want one, do an optional `web_search` for "<company> consensus EPS growth" but treat as soft signal.

## Step 4: Estimate Discount Rate (WACC)

Use `sector` from Step 2.4 with [sector-wacc.md](sector-wacc.md) for base WACC range.

**Default assumptions:**
- Risk-free rate: 4% (US 10-year proxy; adjust for non-USD reporters using local sovereign yield via `web_search`)
- Equity risk premium: 5–6%
- Cost of debt: 5–6% pre-tax (~4% after-tax at 30% tax rate)

Capital structure weights from BS: equity = `market_cap`, debt = `total_debt`.

**Sanity check:** WACC should be 2–4% below ROIC for value-creating companies. ROIC = `operating_income × (1 - tax_rate) / (total_debt + book_equity)` from FR statements.

## Step 5: Project Future Cash Flows

**Years 1–5:** apply growth rate with 5% annual decay (×0.95, 0.90, 0.85, 0.80 for years 2–5) to reflect competitive dynamics.

**Terminal value:** Gordon Growth Model with 2.5% terminal growth (GDP proxy). Use local long-run nominal GDP if reporter is non-US.

## Step 6: Calculate Present Value

Discount each FCF, sum to Enterprise Value, subtract Net Debt (`total_debt - cash_and_equivalents - current_investments`), divide by `outstanding_shares` for fair value per share. Report in the company's reporting currency from Step 2.4.

## Step 7: Fetch Current Price (web fallback — FR has no quote feed)

**Primary:** `web_search` for `"<ticker> stock price <exchange>"` (e.g. "ASML stock price Euronext Amsterdam"), then `web_fetch` the top result for a current quote.

**Backup:** `web_fetch` directly on a Yahoo Finance / Google Finance / TradingView URL for the company's primary listing.

If no reliable quote can be obtained, **report fair value alone** with an explicit "current price unavailable — upside/downside not computed" note. Do not fabricate.

## Step 8: Sensitivity Analysis

3×3 matrix: WACC (base ±1%) vs terminal growth (2.0%, 2.5%, 3.0%).

## Step 9: Validate Results

1. **Per-share cross-check:** compare to (5-year average `free_cash_flow / outstanding_shares`) × 15–25.
2. **Terminal value ratio:** terminal value should be 50–80% of total EV for mature companies.
   - >90%: growth rate too high; revisit Step 3.
   - <40%: near-term projections too aggressive.
3. **Currency consistency:** confirm the per-share output and fetched current price are in the same currency (or convert via FX from web_search).

If validation fails, reconsider assumptions before presenting.

## Step 10: Output Format

Present a structured summary:
1. **Valuation Summary** — current price (with source) vs fair value, upside/downside %, currency.
2. **Key Inputs Table** — every assumption with its source (FR vs web).
3. **Projected FCF Table** — 5-year projections with present values.
4. **Sensitivity Matrix** — 3×3 grid varying WACC (±1%) and terminal growth.
5. **Caveats** — standard DCF limitations + FR-only-build limits:
   - No forward analyst estimates cross-validation
   - Pre-2024 historical depth may be shallow on FR
   - Current price relies on a public web source and may lag real time
