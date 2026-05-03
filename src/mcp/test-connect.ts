/**
 * Manual test: connect to the FinancialReports MCP server via OAuth.
 * This will open a browser window for authorization.
 *
 * Run: bun run src/mcp/test-connect.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { createServer } from 'http';
import { createInterface } from 'readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const SERVER_URL = 'https://mcp.financialfilings.com';
const CALLBACK_PORT = 9876;
const REDIRECT_URI = `${SERVER_URL}/callback`;
const STORAGE_DIR = join(process.env.HOME || '~', '.dexter', 'mcp', 'FinancialReports');

// Ensure storage dir exists
if (!existsSync(STORAGE_DIR)) mkdirSync(STORAGE_DIR, { recursive: true });

function readJson<T>(file: string): T | undefined {
  const p = join(STORAGE_DIR, file);
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : undefined; } catch { return undefined; }
}
function writeJson(file: string, data: unknown) {
  writeFileSync(join(STORAGE_DIR, file), JSON.stringify(data, null, 2));
}

/**
 * Simple OAuth provider that uses the MCP server's /callback as redirect
 * and opens a local server just to capture any local redirects.
 */
class TestOAuthProvider implements OAuthClientProvider {
  private _codeVerifier = '';
  onAuthUrl?: (url: URL) => void;

  get redirectUrl() { return REDIRECT_URI; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Dexter CLI',
    };
  }

  async clientInformation() { return readJson<OAuthClientInformationMixed>('client-info.json'); }
  async saveClientInformation(info: OAuthClientInformationMixed) { writeJson('client-info.json', info); }
  async tokens() { return readJson<OAuthTokens>('tokens.json'); }
  async saveTokens(tokens: OAuthTokens) {
    writeJson('tokens.json', tokens);
    console.log('✅ Tokens saved!');
  }

  async redirectToAuthorization(url: URL) {
    this.onAuthUrl?.(url);
    const { exec } = await import('child_process');
    exec(`open "${url.toString()}"`);
  }

  async saveCodeVerifier(v: string) { this._codeVerifier = v; }
  async codeVerifier() { return this._codeVerifier; }
}

async function main() {
  console.log('🔗 Testing FinancialReports MCP OAuth connection\n');

  // Clear old state for fresh test
  for (const f of ['client-info.json', 'tokens.json']) {
    const p = join(STORAGE_DIR, f);
    if (existsSync(p)) writeFileSync(p, '');
  }

  const provider = new TestOAuthProvider();
  const client = new Client({ name: 'dexter-test', version: '1.0.0' }, { capabilities: {} });

  const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
    authProvider: provider,
  });

  let authUrl: URL | undefined;
  provider.onAuthUrl = (url) => { authUrl = url; };

  try {
    await client.connect(transport);
    console.log('✅ Connected directly (had valid tokens)');
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;

    console.log('🔐 Authorization required. Browser opened.');
    console.log(`\nAuth URL:\n${authUrl}\n`);
    console.log('After signing in, the MCP server will handle the callback.');
    console.log('If a code appears in the URL, paste it below.\n');
    console.log('Otherwise, check if tokens were saved and press Enter to retry.\n');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question('Paste authorization code (or press Enter to retry): ', resolve);
    });
    rl.close();

    if (answer.trim()) {
      console.log('\nExchanging code for tokens...');
      await transport.finishAuth(answer.trim());
    }

    // Retry connection
    console.log('\n🔄 Reconnecting...');
    const client2 = new Client({ name: 'dexter-test', version: '1.0.0' }, { capabilities: {} });
    const transport2 = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
      authProvider: provider,
    });
    await client2.connect(transport2);
    console.log('✅ Connected!\n');

    // List tools
    const { tools } = await client2.listTools();
    console.log(`Found ${tools.length} tools:\n`);
    for (const tool of tools) {
      console.log(`  - ${tool.name}: ${(tool.description || '').slice(0, 80)}`);
    }
  }
}

main().catch(err => {
  console.error('Failed:', err.message || err);
  process.exit(1);
});
