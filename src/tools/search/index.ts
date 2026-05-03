/**
 * Rich description for the web_search tool.
 * Used in the system prompt to guide the LLM on when and how to use this tool.
 */
export const WEB_SEARCH_DESCRIPTION = `
Search the web for current information on any topic. Returns relevant search results with URLs and content snippets.

## When to Use

- Live stock / crypto quotes (no FR equivalent)
- Analyst consensus estimates, insider trades, ownership data (no FR equivalent)
- Breaking news, headlines, market commentary
- Factual questions about entities (companies, people, organizations) where status can change
- Verifying claims about real-world state (public/private, active/defunct, current leadership)
- Research on topics outside of structured filings / financials

## When NOT to Use

- Structured filings, financial statements, ISIN / LEI / FIGI lookups, filing audit trails (use fr_research instead)
- Pure conceptual/definitional questions ("What is a DCF?")

## Usage Notes

- Provide specific, well-formed search queries for best results
- Returns up to 5 results with URLs and content snippets
- Use for supplementary research when fr_research doesn't cover the topic
`.trim();

export { tavilySearch } from './tavily.js';
export { exaSearch } from './exa.js';
export { perplexitySearch } from './perplexity.js';
export { xSearchTool, X_SEARCH_DESCRIPTION } from './x-search.js';
