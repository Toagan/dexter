<div align="center">

# FinancialReports

**An autonomous AI research agent for global public-equity filings.**

> The AI-ready, global, real-time data layer for **46,231 public equities · 21,246,943 filings · 39 filing types** — wrapped in a terminal-native agent that plans, fetches, reads, and reasons.

[Install](#install) · [Sample prompts](#sample-prompts) · [How it works](#how-it-works) · [Tradeoffs](#what-it-isnt)

</div>

---

## What you can ask it

```
> Pull the latest annual revenue and net income for ASML (NL),
  TSMC (TW), and Samsung Electronics (KR) and show me a table.
```
```
> When is BMW's next annual report expected?
```
```
> Read Volkswagen's most recent earnings release and summarize
  the key revenue and margin numbers.
```
```
> Resolve ISIN NL0010273215 to a company and show its last 2 filings.
```
```
> Show me Siemens AG's last 3 fiscal years of revenue, EBITDA,
  and net income.
```

The agent decomposes each question, calls the right `fr_research` actions, fetches the markdown of any filing it needs to read, and writes a final answer with sources. Cross-border comparisons that require US **and** Asian **and** European filings work out of the box — no per-region routing.

## Why FinancialReports

| | |
|---|---|
| 🌍 **Global from day one** | SEC, EDINET, OpenDART, BaFin, AMF, FCA, TWSE, HKEX, SEDAR, ASX, NSE/BSE, CNINFO, B3, JSE, and more |
| 📊 **Capital-IQ-grade financials** | 126 standardized line-item codes — same KPI definitions across geographies, no schema drift |
| 📝 **AI-ready filing markdown** | Every filing is pre-extracted to clean markdown; no PDF parsing needed |
| 🔁 **Push, not poll** | Webhooks deliver new filings as they land, full markdown in the payload |
| 🔍 **Audit trail** | Every filing's full state-transition log — extraction timestamps, classifier confidence (CIQ doesn't expose this) |
| 🧬 **Identifier resolver** | 1.21M ISIN ↔ FIGI mapping built in |
| 📅 **Calendar-aware** | Predicted next-annual-report window with confidence score per company |

## Install

You need: [Bun](https://bun.com), a [FinancialReports.eu](https://financialreports.eu/profile/) API key, and one LLM provider key (Gemini, Anthropic, OpenAI, xAI, OpenRouter, or local Ollama).

```bash
git clone -b fr-only https://github.com/Toagan/dexter.git financialreports
cd financialreports
bun install
cp env.example .env
# Edit .env: set FINANCIAL_REPORTS_API_KEY and one LLM key (e.g. GOOGLE_API_KEY)
bun start
```

That's it — you're at the prompt.

### Pick a model

Type `/model` inside the agent and choose a provider/model. Defaults that work well on this build:

| Provider | Default model | Notes |
|---|---|---|
| Google | `gemini-flash-latest` | Cheapest + fastest tested combo |
| Anthropic | `claude-haiku-4-5` | Best tool-use reliability |
| OpenAI | `gpt-5.4` | Default if no `/model` chosen |
| OpenRouter | `openrouter:anthropic/claude-3.5-sonnet` | Proxy when you want one bill |

## Sample prompts

**Cross-border comparison** (impossible on SEC-only tools)
```
Compare R&D-as-%-of-revenue for Intel (US), TSMC (TW), Samsung (KR),
and Infineon (DE) using their latest annual filings.
```

**DCF in one command** (built-in skill)
```
Run a DCF on ASML and tell me the upside/downside vs current price.
```

**Filing-as-source-of-truth research**
```
Read Volkswagen's most recent annual report and extract everything
they say about EV strategy and Chinese market exposure.
```

**Sector scan**
```
List the 5 European semiconductor companies with the highest revenue
growth in the last reported fiscal year.
```

**Identifier-first**
```
What company is behind LEI 549300DOPHTUDPYAYE83? Show its filing history.
```

## How it works

```
You  ──▶  Agent loop  ──▶  fr_research tool  ──▶  api.financialreports.eu
                       │
                       ├──▶  web_search / web_fetch     ◀── for live quotes,
                       │                                    news, anything FR
                       │                                    doesn't expose
                       └──▶  Skills (DCF, X research…)
```

- **Single structured-data backend.** Every company / filing / financials query routes through one tool (`fr_research`) with 18 actions.
- **Markdown-first reading.** `read_filing` checks `processing_status` and returns the AI-extracted markdown; if the filing isn't processed yet it returns the raw document URL with a hint to fall back via `web_fetch`.
- **No vendor lock-in for non-finance work.** General web/browse/X search tools stay available for prices, news, sentiment, and anything FR doesn't cover.
- **Per-query scratchpad.** Every tool call is logged at `.dexter/scratchpad/<date>_<id>.jsonl` for inspection or replay.
- **Persistent memory.** SQLite + embeddings under `.dexter/memory/` — facts and preferences survive across sessions.

## What it isn't

FinancialReports.eu doesn't (yet) cover:
- Live stock or crypto quotes
- News headlines / press feeds
- Analyst consensus estimates / forward EPS
- Insider trades / institutional ownership / options flow
- Pre-2024 historicals (coverage is shallow for older periods)

For these the agent uses general `web_search` / `web_fetch` and is honest in its answers about which numbers came from FR vs the open web.

## Use it from WhatsApp

```bash
bun run gateway:login   # link via QR code
bun run gateway         # start the gateway
```

Now message yourself in WhatsApp — the agent processes and replies in the same chat.

## Project layout

```
src/
├── agent/             Iterative tool-calling loop, prompts, scratchpad
├── tools/
│   ├── financial-reports/   The fr_research tool (sole structured-data source)
│   ├── fetch/         web_fetch
│   ├── browser/       Playwright browser
│   ├── search/        web_search (Exa / Perplexity / Tavily) and x_search
│   └── memory/        memory_search / memory_get / memory_update
├── skills/            SKILL.md workflows (DCF, x-research)
├── memory/            SQLite + embeddings persistence
├── cron/              Scheduled jobs
├── gateway/           WhatsApp gateway
├── components/        Ink TUI components
└── evals/             LangSmith eval runner
```

Deeper architecture, conventions, and contributor notes live in [AGENTS.md](AGENTS.md).

## Status

- Branch: `fr-only` — this fork removes the original [Dexter](https://github.com/virattt/dexter)'s `financialdatasets.ai` integration and rebuilds the agent's research backbone around the FinancialReports.eu API.
- TypeScript strict, Bun runtime.
- Smoke-tested end-to-end on Gemini Flash + Anthropic + OpenAI.

## Contributing

PRs welcome — keep them small and focused. Run `bun run typecheck && bun test` before pushing.

## License

MIT.
