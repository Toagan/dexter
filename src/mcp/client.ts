/**
 * MCP Client Manager
 *
 * Connects to remote MCP servers, handles OAuth authentication,
 * and converts MCP tools into LangChain DynamicStructuredTools
 * for use in the Dexter agent.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { DexterOAuthProvider } from './oauth-provider.js';
import { formatToolResult } from '../tools/types.js';
import { logger } from '../utils/logger.js';
import type { McpServerConfig } from './config.js';

/**
 * Convert a JSON Schema object to a Zod schema.
 * Handles the common types used by MCP tool input schemas.
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const type = schema.type as string | undefined;
  const description = schema.description as string | undefined;

  let zodType: z.ZodTypeAny;

  switch (type) {
    case 'string': {
      if (schema.enum) {
        const values = schema.enum as [string, ...string[]];
        zodType = z.enum(values);
      } else {
        zodType = z.string();
      }
      break;
    }
    case 'number':
    case 'integer':
      zodType = z.number();
      break;
    case 'boolean':
      zodType = z.boolean();
      break;
    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      zodType = z.array(items ? jsonSchemaToZod(items) : z.unknown());
      break;
    }
    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const required = new Set((schema.required as string[]) || []);
      if (properties) {
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [key, prop] of Object.entries(properties)) {
          let field = jsonSchemaToZod(prop);
          if (!required.has(key)) {
            field = field.optional();
          }
          shape[key] = field;
        }
        zodType = z.object(shape);
      } else {
        zodType = z.record(z.string(), z.unknown());
      }
      break;
    }
    default:
      zodType = z.unknown();
  }

  if (description) {
    zodType = zodType.describe(description);
  }

  return zodType;
}

/**
 * Manages a connection to a single MCP server.
 */
export class McpConnection {
  private client: Client;
  private transport: StreamableHTTPClientTransport | SSEClientTransport | null = null;
  private authProvider: DexterOAuthProvider | null = null;
  private connected = false;

  constructor(private config: McpServerConfig) {
    this.client = new Client(
      { name: 'dexter', version: '1.0.0' },
      { capabilities: {} },
    );
  }

  get name(): string {
    return this.config.name;
  }

  /**
   * Connect to the MCP server with OAuth support.
   * Follows the SDK's pattern: attempt connect → catch UnauthorizedError →
   * wait for browser callback → finishAuth → reconnect.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    const url = new URL(this.config.url);

    if (this.config.auth === 'oauth') {
      this.authProvider = new DexterOAuthProvider(this.config.name, this.config.url);
    }

    await this.attemptConnect(url);
  }

  private async attemptConnect(url: URL): Promise<void> {
    this.transport = new StreamableHTTPClientTransport(url, {
      authProvider: this.authProvider || undefined,
    });

    // Fresh client for each connection attempt
    this.client = new Client(
      { name: 'dexter', version: '1.0.0' },
      { capabilities: {} },
    );

    try {
      await this.client.connect(this.transport);
      this.connected = true;
      logger.info(`[MCP] Connected to ${this.config.name}`);
    } catch (err: unknown) {
      if (err instanceof UnauthorizedError && this.authProvider) {
        // The SDK already called redirectToAuthorization on our authProvider,
        // which opened the browser and started listening for the callback.
        console.log(`\n🔐 ${this.config.name} requires authorization.`);
        console.log('   A browser window has opened for sign-in.');
        console.log('   Waiting for authorization...\n');

        // Wait for the user to complete auth in the browser
        const code = await this.authProvider.waitForAuthorizationCode();
        logger.info(`[MCP] Got authorization code for ${this.config.name}`);

        // Exchange code for tokens
        await this.transport.finishAuth(code);

        // Reconnect with the new tokens
        await this.attemptConnect(url);
        return;
      }

      // Not an auth error — try SSE fallback
      logger.info(`[MCP] StreamableHTTP failed for ${this.config.name}, trying SSE...`);
      try {
        this.transport = new SSEClientTransport(url, {
          authProvider: this.authProvider || undefined,
        } as any);

        this.client = new Client(
          { name: 'dexter', version: '1.0.0' },
          { capabilities: {} },
        );

        await this.client.connect(this.transport);
        this.connected = true;
        logger.info(`[MCP] Connected to ${this.config.name} via SSE`);
      } catch (sseErr: unknown) {
        if (sseErr instanceof UnauthorizedError && this.authProvider) {
          console.log(`\n🔐 ${this.config.name} requires authorization.`);
          console.log('   A browser window has opened for sign-in.');
          console.log('   Waiting for authorization...\n');

          const code = await this.authProvider.waitForAuthorizationCode();
          await (this.transport as any).finishAuth?.(code);
          await this.attemptConnect(url);
          return;
        }
        throw sseErr;
      }
    }
  }

  /**
   * List all tools from this MCP server.
   */
  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>> {
    if (!this.connected) {
      await this.connect();
    }

    const allTools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = [];
    let cursor: string | undefined;

    do {
      const result = await this.client.listTools({ cursor });
      allTools.push(...result.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      })));
      cursor = result.nextCursor;
    } while (cursor);

    return allTools;
  }

  /**
   * Call a tool on this MCP server.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.client.callTool({ name, arguments: args });
    const content = result.content as Array<Record<string, unknown>>;

    if (result.isError) {
      const errorText = content
        .map((c) => (c.text as string) || JSON.stringify(c))
        .join('\n');
      throw new Error(`MCP tool error: ${errorText}`);
    }

    // Extract text content from MCP response
    const texts: string[] = [];
    for (const block of content) {
      if (block.type === 'text') {
        texts.push(block.text as string);
      } else {
        texts.push(JSON.stringify(block));
      }
    }

    return texts.join('\n');
  }

  /**
   * Convert all MCP tools from this server into LangChain DynamicStructuredTools.
   */
  async toLangChainTools(): Promise<DynamicStructuredTool[]> {
    const mcpTools = await this.listTools();
    const prefix = this.config.toolPrefix || this.config.name.toLowerCase().replace(/[^a-z0-9]/g, '_');

    return mcpTools.map((mcpTool) => {
      // Build zod schema from JSON Schema
      let schema: z.ZodObject<any>;
      try {
        const zodSchema = jsonSchemaToZod(mcpTool.inputSchema);
        schema = zodSchema instanceof z.ZodObject ? zodSchema : z.object({ input: zodSchema });
      } catch {
        schema = z.object({});
      }

      const toolName = `${prefix}_${mcpTool.name}`;

      return new DynamicStructuredTool({
        name: toolName,
        description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
        schema,
        func: async (input: Record<string, unknown>) => {
          try {
            const result = await this.callTool(mcpTool.name, input);
            // Try to parse as JSON for formatToolResult, otherwise wrap as text
            try {
              const parsed = JSON.parse(result);
              return formatToolResult(parsed);
            } catch {
              return formatToolResult({ text: result });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`[MCP] ${toolName} failed: ${message}`);
            return formatToolResult({ error: message });
          }
        },
      });
    });
  }

  /**
   * Disconnect from the server.
   */
  async disconnect(): Promise<void> {
    if (this.connected && this.transport) {
      await this.transport.close();
      this.connected = false;
    }
  }
}
