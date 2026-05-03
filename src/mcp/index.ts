/**
 * MCP integration entry point.
 *
 * Loads MCP server configs, connects to them, and provides
 * LangChain tools for the Dexter agent.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { McpConnection } from './client.js';
import { loadMcpConfig, type McpServerConfig } from './config.js';
import { logger } from '../utils/logger.js';

export type { McpServerConfig } from './config.js';

let connections: McpConnection[] = [];
let initialized = false;

/**
 * Initialize MCP connections from config.
 * Safe to call multiple times — only initializes once.
 */
async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const configs = loadMcpConfig();
  if (configs.length === 0) {
    logger.info('[MCP] No MCP servers configured');
    return;
  }

  for (const config of configs) {
    try {
      const conn = new McpConnection(config);
      await conn.connect();
      connections.push(conn);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[MCP] Failed to connect to ${config.name}: ${msg}`);
      console.error(`⚠️  MCP server "${config.name}" failed to connect: ${msg}`);
    }
  }
}

/**
 * Get all LangChain tools from connected MCP servers.
 * Connects to servers on first call.
 */
export async function getMcpTools(): Promise<DynamicStructuredTool[]> {
  await ensureInitialized();

  const allTools: DynamicStructuredTool[] = [];

  for (const conn of connections) {
    try {
      const tools = await conn.toLangChainTools();
      allTools.push(...tools);
      logger.info(`[MCP] Loaded ${tools.length} tools from ${conn.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[MCP] Failed to load tools from ${conn.name}: ${msg}`);
    }
  }

  return allTools;
}

/**
 * Build compact descriptions for MCP tools (for system prompt).
 */
export function buildMcpToolDescriptions(tools: DynamicStructuredTool[]): string {
  return tools.map(t => `- **${t.name}**: ${t.description}`).join('\n');
}

/**
 * Disconnect all MCP servers. Call on shutdown.
 */
export async function disconnectMcpServers(): Promise<void> {
  for (const conn of connections) {
    try {
      await conn.disconnect();
    } catch { /* ignore */ }
  }
  connections = [];
  initialized = false;
}
