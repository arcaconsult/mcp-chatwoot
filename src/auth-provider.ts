/**
 * Minimal OAuth 2.1 authorization server provider for this MCP server,
 * following the same pattern used elsewhere at Arcaconsult
 * (olist-arca-mcp, mcp-glpi): the MCP server itself is the OAuth server,
 * Claude's OAuth client is registered dynamically, and the human "login" is
 * just a password gate (MCP_AUTH_PASSWORD) checked before an authorization
 * code is ever issued (see the /login route in index-http.ts).
 *
 * Access tokens last one hour and come with a refresh token, so Claude renews
 * them on its own instead of asking for the password again. Refresh tokens are
 * rotated on every use and, by default, never expire (single operator).
 *
 * Registered clients and tokens are persisted to a JSON file (OAUTH_STATE_FILE,
 * on a Docker volume) so a restart or rebuild keeps every connection alive.
 * Tokens are stored as SHA-256 hashes, never in the clear. Authorization codes
 * live five minutes and stay in memory only.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = Number(process.env.MCP_OAUTH_ACCESS_TTL ?? 3600) * 1000;
// 0 = refresh tokens never expire (convenient for a single operator).
const REFRESH_TTL_MS = Number(process.env.MCP_OAUTH_REFRESH_TTL ?? 0) * 1000;
const STATE_FILE = process.env.OAUTH_STATE_FILE ?? "/app/data/oauth-state.json";

interface StoredCode {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}

interface StoredToken {
  clientId: string;
  scopes: string[];
  expiresAt: number | null; // epoch ms; null = never
  resource?: string;
  pairHash: string; // hash of the other half (access <-> refresh)
}

interface PersistedState {
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, StoredToken>;
  refresh: Record<string, StoredToken>;
}

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

class StateStore {
  state: PersistedState = { clients: {}, access: {}, refresh: {} };

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        this.state = {
          ...this.state,
          ...JSON.parse(readFileSync(file, "utf8")),
        };
      } catch (error) {
        console.error(
          `Could not read ${file}, starting with empty OAuth state:`,
          error,
        );
      }
    }
    this.prune();
  }

  // Drops expired tokens so the file does not grow forever.
  prune() {
    const now = Date.now();
    for (const kind of ["access", "refresh"] as const) {
      for (const [key, token] of Object.entries(this.state[kind])) {
        if (token.expiresAt !== null && token.expiresAt < now)
          delete this.state[kind][key];
      }
    }
  }

  save() {
    this.prune();
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

class PersistentClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly store: StateStore) {}

  async getClient(clientId: string) {
    return this.store.state.clients[clientId];
  }

  async registerClient(client: OAuthClientInformationFull) {
    this.store.state.clients[client.client_id] = client;
    this.store.save();
    return client;
  }
}

export class ChatwootMcpAuthProvider implements OAuthServerProvider {
  private readonly store = new StateStore(STATE_FILE);
  readonly clientsStore = new PersistentClientsStore(this.store);
  private readonly codes = new Map<string, StoredCode>();

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // By the time we get here, the password gate in index-http.ts has
    // already confirmed the human is authorized (valid session cookie).
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }

    const code = randomUUID();
    this.codes.set(code, {
      client,
      params,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state !== undefined) {
      target.searchParams.set("state", params.state);
    }
    res.redirect(target.toString());
  }

  private getCode(authorizationCode: string): StoredCode {
    const stored = this.codes.get(authorizationCode);
    if (!stored || stored.expiresAt < Date.now()) {
      this.codes.delete(authorizationCode);
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return stored;
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.getCode(authorizationCode).params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const stored = this.getCode(authorizationCode);
    if (stored.client.client_id !== client.client_id) {
      throw new InvalidGrantError(
        "Authorization code was not issued to this client",
      );
    }
    this.codes.delete(authorizationCode);
    return this.issueTokens(
      client.client_id,
      stored.params.scopes ?? [],
      stored.params.resource?.href,
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const key = hash(refreshToken);
    const stored = this.store.state.refresh[key];
    if (
      !stored ||
      (stored.expiresAt !== null && stored.expiresAt < Date.now())
    ) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (stored.clientId !== client.client_id) {
      throw new InvalidGrantError(
        "Refresh token was not issued to this client",
      );
    }
    // Rotate: the used refresh token and its access token stop working.
    delete this.store.state.refresh[key];
    delete this.store.state.access[stored.pairHash];
    return this.issueTokens(
      client.client_id,
      scopes?.length ? scopes : stored.scopes,
      resource?.href ?? stored.resource,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.store.state.access[hash(token)];
    // InvalidTokenError makes the SDK answer 401 with WWW-Authenticate, which
    // tells Claude to refresh; a plain Error would surface as a 500.
    if (!stored || stored.expiresAt === null || stored.expiresAt < Date.now()) {
      throw new InvalidTokenError("Invalid or expired token");
    }
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: Math.floor(stored.expiresAt / 1000),
      resource: stored.resource ? new URL(stored.resource) : undefined,
    };
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource?: string,
  ): OAuthTokens {
    const now = Date.now();
    const access = randomBytes(32).toString("base64url");
    const refresh = randomBytes(32).toString("base64url");
    const accessHash = hash(access);
    const refreshHash = hash(refresh);

    this.store.state.access[accessHash] = {
      clientId,
      scopes,
      expiresAt: now + ACCESS_TTL_MS,
      resource,
      pairHash: refreshHash,
    };
    this.store.state.refresh[refreshHash] = {
      clientId,
      scopes,
      expiresAt: REFRESH_TTL_MS > 0 ? now + REFRESH_TTL_MS : null,
      resource,
      pairHash: accessHash,
    };
    this.store.save();

    return {
      access_token: access,
      token_type: "bearer",
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }
}
