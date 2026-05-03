import { StructuredToolInterface } from '@langchain/core/tools';
import { exaSearch, perplexitySearch, tavilySearch, WEB_SEARCH_DESCRIPTION, xSearchTool, X_SEARCH_DESCRIPTION } from './search/index.js';
import { skillTool, SKILL_TOOL_DESCRIPTION } from './skill.js';
import { webFetchTool, WEB_FETCH_DESCRIPTION } from './fetch/web-fetch.js';
import { browserTool, BROWSER_DESCRIPTION } from './browser/browser.js';
import { readFileTool, READ_FILE_DESCRIPTION } from './filesystem/read-file.js';
import { writeFileTool, WRITE_FILE_DESCRIPTION } from './filesystem/write-file.js';
import { editFileTool, EDIT_FILE_DESCRIPTION } from './filesystem/edit-file.js';
import { heartbeatTool, HEARTBEAT_TOOL_DESCRIPTION } from './heartbeat/heartbeat-tool.js';
import { cronTool, CRON_TOOL_DESCRIPTION } from './cron/cron-tool.js';
import { memoryGetTool, MEMORY_GET_DESCRIPTION, memorySearchTool, MEMORY_SEARCH_DESCRIPTION, memoryUpdateTool, MEMORY_UPDATE_DESCRIPTION } from './memory/index.js';
import { createFrResearch, FR_RESEARCH_DESCRIPTION } from './financial-reports/index.js';
import { discoverSkills } from '../skills/index.js';

/**
 * A registered tool with its rich description for system prompt injection.
 */
export interface RegisteredTool {
  /** Tool name (must match the tool's name property) */
  name: string;
  /** The actual tool instance */
  tool: StructuredToolInterface;
  /** Rich description for system prompt (includes when to use, when not to use, etc.) */
  description: string;
  /** 1-2 sentence description for token-optimized system prompts. */
  compactDescription: string;
  /** Whether this tool can safely execute concurrently with other concurrent-safe tools. */
  concurrencySafe: boolean;
}

/**
 * Get all registered tools with their descriptions.
 *
 * In this build of Dexter, FinancialReports.eu is the sole structured-data
 * source. Web/browser/x_search remain available for prices, news, estimates,
 * and other surfaces FR doesn't cover.
 *
 * @param _model - Reserved for future model-specific tool config
 */
export function getToolRegistry(_model: string): RegisteredTool[] {
  const tools: RegisteredTool[] = [];

  // ----------------------------------------------------------- FinancialReports
  // Required: registered unconditionally and treated as the canonical research backend.
  tools.push({
    name: 'fr_research',
    tool: createFrResearch(),
    description: FR_RESEARCH_DESCRIPTION,
    compactDescription:
      'Sole structured-data source. Companies, filings (markdown + raw fallback), Capital-IQ-grade financials, ISIN resolution, audit trails, watchlist. G20 coverage (~46K cos, 20M+ filings).',
    concurrencySafe: true,
  });

  // --------------------------------------------------------------------- Web
  tools.push({
    name: 'web_fetch',
    tool: webFetchTool,
    description: WEB_FETCH_DESCRIPTION,
    compactDescription:
      'Fetch and extract content from a URL as markdown. Use for live quotes, news, raw filing fallback (when fr_research returns markdown_available=false).',
    concurrencySafe: true,
  });

  tools.push({
    name: 'browser',
    tool: browserTool,
    description: BROWSER_DESCRIPTION,
    compactDescription: 'JavaScript-rendered pages and interactive navigation. Actions: navigate, snapshot, act, read, close.',
    concurrencySafe: true,
  });

  // ----------------------------------------------------------------- Filesystem
  tools.push(
    {
      name: 'read_file',
      tool: readFileTool,
      description: READ_FILE_DESCRIPTION,
      compactDescription: 'Read a local file by path. Returns file content as text.',
      concurrencySafe: true,
    },
    {
      name: 'write_file',
      tool: writeFileTool,
      description: WRITE_FILE_DESCRIPTION,
      compactDescription: 'Create or overwrite a file. Requires user approval.',
      concurrencySafe: false,
    },
    {
      name: 'edit_file',
      tool: editFileTool,
      description: EDIT_FILE_DESCRIPTION,
      compactDescription: 'Edit a file by replacing text. Requires user approval.',
      concurrencySafe: false,
    },
  );

  // ------------------------------------------------------------------ Workflow
  tools.push(
    {
      name: 'heartbeat',
      tool: heartbeatTool,
      description: HEARTBEAT_TOOL_DESCRIPTION,
      compactDescription: 'View or update the periodic heartbeat checklist (.dexter/HEARTBEAT.md).',
      concurrencySafe: true,
    },
    {
      name: 'cron',
      tool: cronTool,
      description: CRON_TOOL_DESCRIPTION,
      compactDescription: 'Manage scheduled cron jobs (create, list, update, delete).',
      concurrencySafe: true,
    },
    {
      name: 'memory_search',
      tool: memorySearchTool,
      description: MEMORY_SEARCH_DESCRIPTION,
      compactDescription: 'Search persistent memory and past conversations for stored facts and preferences.',
      concurrencySafe: true,
    },
    {
      name: 'memory_get',
      tool: memoryGetTool,
      description: MEMORY_GET_DESCRIPTION,
      compactDescription: 'Read specific memory file sections by line range.',
      concurrencySafe: true,
    },
    {
      name: 'memory_update',
      tool: memoryUpdateTool,
      description: MEMORY_UPDATE_DESCRIPTION,
      compactDescription: 'Add, edit, or delete persistent memory entries.',
      concurrencySafe: false,
    },
  );

  // ----------------------------------------------- Web search (env-dependent)
  if (process.env.EXASEARCH_API_KEY) {
    tools.push({
      name: 'web_search',
      tool: exaSearch,
      description: WEB_SEARCH_DESCRIPTION,
      compactDescription: 'Search the web for current information (quotes, news, estimates that FR does not cover). Returns titles, URLs, and highlights.',
      concurrencySafe: true,
    });
  } else if (process.env.PERPLEXITY_API_KEY) {
    tools.push({
      name: 'web_search',
      tool: perplexitySearch,
      description: WEB_SEARCH_DESCRIPTION,
      compactDescription: 'Search the web for current information (quotes, news, estimates that FR does not cover). Returns an answer with citations.',
      concurrencySafe: true,
    });
  } else if (process.env.TAVILY_API_KEY) {
    tools.push({
      name: 'web_search',
      tool: tavilySearch,
      description: WEB_SEARCH_DESCRIPTION,
      compactDescription: 'Search the web for current information (quotes, news, estimates that FR does not cover). Returns titles, URLs, and snippets.',
      concurrencySafe: true,
    });
  }

  if (process.env.X_BEARER_TOKEN) {
    tools.push({
      name: 'x_search',
      tool: xSearchTool,
      description: X_SEARCH_DESCRIPTION,
      compactDescription: 'Search X/Twitter for tweets, profiles, and threads.',
      concurrencySafe: true,
    });
  }

  // ---------------------------------------------------------------- Skills
  const availableSkills = discoverSkills();
  if (availableSkills.length > 0) {
    tools.push({
      name: 'skill',
      tool: skillTool,
      description: SKILL_TOOL_DESCRIPTION,
      compactDescription: 'Invoke a specialized skill workflow (e.g., DCF valuation).',
      concurrencySafe: false,
    });
  }

  return tools;
}

/**
 * Build a name → concurrencySafe map for the tool executor.
 */
export function getToolConcurrencyMap(model: string): Map<string, boolean> {
  return new Map(getToolRegistry(model).map(t => [t.name, t.concurrencySafe]));
}

/**
 * Get just the tool instances for binding to the LLM.
 *
 * @param model - The model name
 * @returns Array of tool instances
 */
export function getTools(model: string): StructuredToolInterface[] {
  return getToolRegistry(model).map((t) => t.tool);
}

/**
 * Build compact tool descriptions for token-optimized system prompts.
 * Uses 1-2 sentence descriptions instead of full multi-paragraph ones.
 * The LLM already has full tool schemas via bindTools().
 */
export function buildCompactToolDescriptions(model: string): string {
  return getToolRegistry(model)
    .map((t) => `- **${t.name}**: ${t.compactDescription}`)
    .join('\n');
}
