/**
 * OAuth provider for MCP servers that require browser-based authorization.
 *
 * Supports two redirect patterns:
 * 1. Server-side callback: The MCP server's own /callback endpoint is the redirect URI
 *    (whitelisted in the upstream IdP). After auth, it redirects to our local server.
 * 2. Local callback: Direct redirect to localhost (when allowed by the IdP).
 *
 * Tokens are persisted to disk for reuse across sessions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createServer, type Server } from 'http';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { logger } from '../utils/logger.js';

const CALLBACK_PORT = 9876;
const CALLBACK_PATH = '/oauth/callback';
const LOCAL_REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

/** Directory to persist tokens and client info */
function getStorageDir(serverName: string): string {
  const dir = join(process.env.HOME || '~', '.dexter', 'mcp', serverName);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function readJson<T>(path: string): T | undefined {
  try {
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8').trim();
      if (data && data !== '{}') {
        return JSON.parse(data) as T;
      }
    }
  } catch {
    // Corrupted file, ignore
  }
  return undefined;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Wait for the OAuth callback by spinning up a temporary local HTTP server.
 * Returns the authorization code from the redirect.
 */
function waitForCallback(timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let server: Server;
    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error('OAuth callback timed out'));
    }, timeoutMs);

    server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${CALLBACK_PORT}`);

      // Accept callback on any path (the server might redirect to / or /oauth/callback)
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Authorization failed</h2><p>${error}</p><p>You can close this tab.</p></body></html>`);
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to FinancialReports.</p></body></html>');
        clearTimeout(timeout);
        server.close();
        resolve(code);
        return;
      }

      // No code yet — might be a favicon or other request, just 200 it
      if (url.pathname === '/favicon.ico') {
        res.writeHead(404);
        res.end();
        return;
      }

      // For any other request, return a waiting page
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Waiting for authorization...</h2></body></html>');
    });

    server.listen(CALLBACK_PORT, () => {
      logger.info(`[MCP OAuth] Listening for callback on port ${CALLBACK_PORT}`);
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
    });
  });
}

export class DexterOAuthProvider implements OAuthClientProvider {
  private storageDir: string;
  private _codeVerifier: string = '';
  private callbackPromise: Promise<string> | undefined;
  private serverCallbackUrl: string | undefined;

  /**
   * @param serverName - Name of the MCP server (used for storage)
   * @param serverUrl - The MCP server URL (used to construct server-side callback)
   */
  constructor(private serverName: string, serverUrl?: string) {
    this.storageDir = getStorageDir(serverName);
    // Use server's own /callback as redirect (to pass IdP whitelist)
    if (serverUrl) {
      const base = new URL(serverUrl);
      this.serverCallbackUrl = `${base.origin}/callback`;
    }
  }

  get redirectUrl(): string {
    // Use the server's callback URL if available (works with IdP whitelists),
    // otherwise fall back to local
    return this.serverCallbackUrl || LOCAL_REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: `FinancialReports (${this.serverName})`,
      client_uri: 'https://github.com/Toagan/dexter',
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return readJson<OAuthClientInformationMixed>(join(this.storageDir, 'client-info.json'));
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    writeJson(join(this.storageDir, 'client-info.json'), info);
    logger.info(`[MCP OAuth] Saved client registration for ${this.serverName}`);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return readJson<OAuthTokens>(join(this.storageDir, 'tokens.json'));
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    writeJson(join(this.storageDir, 'tokens.json'), tokens);
    logger.info(`[MCP OAuth] Saved tokens for ${this.serverName}`);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // If using server-side callback, we need to intercept differently.
    // The MCP server's /callback will receive the code from Cognito and then
    // it should redirect the user. We'll modify the auth URL to include a
    // state parameter with our local redirect so the server knows where to send us.

    // For now, always start the local callback server.
    // If the server-side callback knows to redirect to us, we'll catch it.
    this.callbackPromise = waitForCallback();

    // If using server callback, add our local redirect as the state
    // so the server can redirect back to us after handling the code
    const url = new URL(authorizationUrl.toString());
    if (this.serverCallbackUrl) {
      // Encode our local callback in the state param
      const stateData = JSON.stringify({
        local_redirect: LOCAL_REDIRECT_URI,
        original_state: url.searchParams.get('state') || '',
      });
      url.searchParams.set('state', Buffer.from(stateData).toString('base64url'));
    }

    // Open browser
    const { exec } = await import('child_process');
    const urlStr = url.toString();
    logger.info(`[MCP OAuth] Opening browser for authorization: ${urlStr}`);
    console.log(`\n   Auth URL: ${urlStr}\n`);

    const platform = process.platform;
    const cmd =
      platform === 'darwin' ? `open "${urlStr}"` :
      platform === 'win32' ? `start "${urlStr}"` :
      `xdg-open "${urlStr}"`;

    exec(cmd, (err) => {
      if (err) {
        logger.error(`[MCP OAuth] Failed to open browser. Please visit: ${urlStr}`);
      }
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this._codeVerifier = codeVerifier;
    // Also persist to disk in case we need it after browser redirect
    writeJson(join(this.storageDir, 'code-verifier.json'), { codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    if (this._codeVerifier) return this._codeVerifier;
    const stored = readJson<{ codeVerifier: string }>(join(this.storageDir, 'code-verifier.json'));
    return stored?.codeVerifier || '';
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const files: Record<string, string[]> = {
      tokens: ['tokens.json'],
      client: ['client-info.json'],
      verifier: ['code-verifier.json'],
      discovery: [],
      all: ['tokens.json', 'client-info.json', 'code-verifier.json'],
    };
    for (const file of files[scope] || []) {
      const path = join(this.storageDir, file);
      try {
        if (existsSync(path)) writeFileSync(path, '');
      } catch { /* ignore */ }
    }
  }

  /**
   * Wait for the authorization callback and return the code.
   */
  async waitForAuthorizationCode(): Promise<string> {
    if (!this.callbackPromise) {
      throw new Error('No authorization flow in progress');
    }
    const code = await this.callbackPromise;
    this.callbackPromise = undefined;
    return code;
  }
}
