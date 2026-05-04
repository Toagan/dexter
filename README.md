# FinancialReports 🤖

**FinancialReports** is an autonomous financial research agent that thinks, plans, and learns as it works. It is powered exclusively by the [FinancialReports.eu](https://financialreports.eu) API — covering ~46K companies and 20M+ regulatory filings across G20 markets (SEC, EDINET, OpenDART, BaFin, AMF, FCA, TWSE, HKEX, SEDAR, ASX, NSE/BSE, CNINFO, B3, JSE, etc.), with Capital-IQ-grade standardized line items, AI-ready filing markdown, ISIN ↔ FIGI mapping, and webhook streaming.

Think Claude Code, but for global filings + financials, with no US-centric bias.

## What changed in this fork

**Removed:**
- Financial Datasets API integration (`get_financials`, `get_market_data`, `read_filings`, `stock_screener`)
- The `FINANCIAL_DATASETS_API_KEY` requirement

**Added:**
- Unified `fr_research` tool exposing the full FinancialReports.eu surface (companies, filings with markdown + raw-document fallback, Capital-IQ-grade financials, audit trails, ISINs, line-item taxonomy, watchlist).
- Two-step `read_filing` that checks `processing_status` and returns the raw document URL when markdown isn't ready, so the agent can fall back via `web_fetch`.

**Tradeoffs (FR doesn't cover):**
- Live stock / crypto quotes
- Breaking news headlines
- Analyst consensus estimates / forward EPS
- Insider trades / institutional ownership / options flow
- Pre-2024 historicals (FR coverage is shallow for older periods)

`web_search`, `web_fetch`, `browser`, and `x_search` remain available for these surfaces. The DCF skill, for example, fetches current price via `web_search` + `web_fetch` and explicitly notes when an estimate is unavailable.

## Tools exposed to the agent

| Tool | Source | Purpose |
|---|---|---|
| **fr_research** | FinancialReports.eu | All structured financial data — companies, filings, financials, ISINs, audit trails, watchlist |
| web_search | Exa / Perplexity / Tavily | Live quotes, news, anything FR doesn't cover |
| web_fetch | local fetch + Readability | Extract a URL as markdown — also the raw-filing fallback |
| browser | Playwright | JS-rendered pages, multi-step navigation |
| x_search | X API | Sentiment, breaking signals |
| read_file / write_file / edit_file | local | Workspace files |
| memory_search / memory_get / memory_update | local SQLite + embeddings | Persistent memory |
| heartbeat | local | Periodic checklist |
| cron | local | Scheduled jobs |
| skill | local | Invoke SKILL.md workflows (e.g. DCF) |

## ✅ Prerequisites

- [Bun](https://bun.com) runtime (v1.0+)
- A FinancialReports.eu API key (get one at https://financialreports.eu/profile/)
- An LLM provider key (OpenAI, Anthropic, Google, xAI, OpenRouter, or local Ollama)
- Optional: Exa / Perplexity / Tavily for `web_search`, X bearer token for `x_search`

#### Installing Bun

```bash
# macOS / Linux
curl -fsSL https://bun.com/install | bash

# Windows
powershell -c "irm bun.sh/install.ps1|iex"
```

After install, restart your terminal and verify: `bun --version`.

## 💻 How to Install

```bash
git clone <this-fork-url>
cd dexter
bun install
cp env.example .env
# Edit .env — at minimum set FINANCIAL_REPORTS_API_KEY plus one LLM provider key
```

## 🚀 How to Run

Interactive mode:
```bash
bun start
```

Watch mode for development:
```bash
bun dev
```

## 📊 How to Evaluate

```bash
bun run src/evals/run.ts            # full dataset
bun run src/evals/run.ts --sample 10  # random sample
```

Eval results are uploaded to LangSmith.

## 🐛 How to Debug

Per-query tool-call trace at `.dexter/scratchpad/<date>_<id>.jsonl` — newline-delimited JSON with `init`, `tool_result`, `thinking` entries.

## 📱 How to Use with WhatsApp

```bash
bun run gateway:login   # link WhatsApp via QR code
bun run gateway         # start the gateway
```

Then message yourself in WhatsApp; FinancialReports processes and replies.

## 🤝 How to Contribute

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

Please keep PRs small and focused.

## 📄 License

MIT.
