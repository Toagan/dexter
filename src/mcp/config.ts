/**
 * MCP server configuration.
 * Loaded from .dexter/mcp.json or environment variables.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';

export interface McpServerConfig {
  /** Display name for this server */
  name: string;
  /** Server URL (SSE or StreamableHTTP endpoint) */
  url: string;
  /** Auth method: 'oauth' for browser-based OAuth2, 'header' for static API key, 'none' */
  auth: 'oauth' | 'header' | 'none';
  /** For 'header' auth: the header name (default: 'Authorization') */
  authHeader?: string;
  /** For 'header' auth: the header value (e.g., 'Bearer xxx') or env var reference like '$MY_API_KEY' */
  authValue?: string;
  /** Prefix for tool names (default: derived from server name) */
  toolPrefix?: string;
  /** Whether this server is enabled (default: true) */
  enabled?: boolean;
}

interface McpConfig {
  servers: McpServerConfig[];
}

const CONFIG_PATHS = [
  join(process.cwd(), '.dexter', 'mcp.json'),
  join(process.env.HOME || '~', '.dexter', 'mcp.json'),
];

/**
 * Load MCP server configurations from config files.
 */
export function loadMcpConfig(): McpServerConfig[] {
  for (const configPath of CONFIG_PATHS) {
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw) as McpConfig;
        const servers = (config.servers || []).filter(s => s.enabled !== false);

        // Resolve env var references in auth values
        for (const server of servers) {
          if (server.authValue?.startsWith('$')) {
            const envVar = server.authValue.slice(1);
            server.authValue = process.env[envVar] || '';
            if (!server.authValue) {
              logger.warn(`[MCP Config] Environment variable ${envVar} not set for server ${server.name}`);
            }
          }
        }

        logger.info(`[MCP Config] Loaded ${servers.length} server(s) from ${configPath}`);
        return servers;
      } catch (err) {
        logger.error(`[MCP Config] Failed to parse ${configPath}: ${err}`);
      }
    }
  }

  return [];
}
