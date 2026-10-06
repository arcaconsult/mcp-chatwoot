/**
 * HTTP (Streamable HTTP) entrypoint for the Chatwoot MCP server, with a
 * self-contained OAuth 2.1 authorization server (same pattern as
 * olist-arca-mcp / mcp-glpi): Claude registers as an OAuth client via DCR,
 * a human approves once by typing MCP_AUTH_PASSWORD on a login page, and
 * Claude gets a bearer token it uses on every /mcp call afterwards.
 *
 * No manual "Request headers" configuration needed on the Claude side —
 * leave the connector's OAuth fields empty and it just works, like the
 * other Arcaconsult MCPs.
 */
import { randomUUID } from "node:crypto";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request } from "express";
import { ChatwootMcpAuthProvider } from "@/auth-provider.ts";
import { ChatwootClient } from "@/client.ts";
import { createServer } from "@/server.ts";

const baseUrl = process.env.CHATWOOT_BASE_URL;
const apiToken = process.env.CHATWOOT_API_TOKEN;
const authPassword = process.env.MCP_AUTH_PASSWORD;
const publicUrl = process.env.PUBLIC_URL;
const port = Number(process.env.PORT ?? 3000);

for (const [name, value] of Object.entries({
  CHATWOOT_BASE_URL: baseUrl,
  CHATWOOT_API_TOKEN: apiToken,
  MCP_AUTH_PASSWORD: authPassword,
  PUBLIC_URL: publicUrl,
})) {
  if (!value) {
    console.error(`${name} environment variable is required`);
    process.exit(1);
  }
}

const issuerUrl = new URL(publicUrl as string);
const mcpUrl = new URL("/mcp", issuerUrl);

const chatwootClient = new ChatwootClient(
  baseUrl as string,
  apiToken as string,
);
const authProvider = new ChatwootMcpAuthProvider();

// ── Tiny in-memory "human approved" session, set after the password gate ──
const approvedSessions = new Map<string, number>(); // sessionId -> expiresAt
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes is plenty for the redirect dance

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(
      part.slice(idx + 1).trim(),
    );
  }
  return out;
}

function hasValidSession(req: Request): boolean {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies.mcp_session;
  if (!sessionId) return false;
  const expiresAt = approvedSessions.get(sessionId);
  if (!expiresAt || expiresAt < Date.now()) {
    approvedSessions.delete(sessionId);
    return false;
  }
  return true;
}

function loginPage(returnTo: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>mcp-chatwoot</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  form{background:#1e293b;padding:2rem 2.5rem;border-radius:12px;min-width:320px}
  h1{font-size:1.1rem;margin:0 0 1rem}
  input[type=password]{width:100%;padding:.6rem;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;box-sizing:border-box}
  button{margin-top:1rem;width:100%;padding:.6rem;border:none;border-radius:6px;background:#6366f1;color:white;font-weight:600;cursor:pointer}
  .err{color:#f87171;font-size:.9rem;margin-top:.5rem}
</style></head>
<body>
  <form method="POST" action="/login">
    <h1>mcp-chatwoot — autorizar acesso</h1>
    <input type="password" name="password" placeholder="Senha" autofocus required>
    <input type="hidden" name="return_to" value="${returnTo.replace(/"/g, "&quot;")}">
    <button type="submit">Autorizar</button>
    ${error ? `<div class="err">${error}</div>` : ""}
  </form>
</body></html>`;
}

const app = express();
app.set("trust proxy", 1);

// ── Password gate: runs before the SDK's own /authorize handler ──
app.get("/authorize", (req, res, next) => {
  if (hasValidSession(req)) return next();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(loginPage(req.originalUrl));
});

app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  const { password, return_to: returnTo } = req.body as Record<string, string>;
  if (password !== authPassword) {
    res.status(401);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(loginPage(returnTo ?? "/authorize", "Senha incorreta."));
    return;
  }
  const sessionId = randomUUID();
  approvedSessions.set(sessionId, Date.now() + SESSION_TTL_MS);
  res.setHeader(
    "Set-Cookie",
    `mcp_session=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
  );
  res.redirect(302, returnTo || "/authorize");
});

// ── Standard MCP OAuth endpoints (metadata, /authorize, /token, /register) ──
app.use(
  mcpAuthRouter({
    provider: authProvider,
    issuerUrl,
    resourceServerUrl: mcpUrl,
    scopesSupported: ["mcp"],
    resourceName: "Chatwoot MCP (Arcaconsult)",
  }),
);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

const requireAuth = requireBearerAuth({
  verifier: authProvider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
});

app.post("/mcp", requireAuth, async (req, res) => {
  try {
    const server = createServer(chatwootClient);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless server: GET/DELETE on /mcp are not used (no sessions to resume or close).
app.get("/mcp", requireAuth, (_req, res) => {
  res.status(405).json({ error: "Method Not Allowed" });
});
app.delete("/mcp", requireAuth, (_req, res) => {
  res.status(405).json({ error: "Method Not Allowed" });
});

app.listen(port, () => {
  console.log(
    `mcp-chatwoot HTTP transport listening on http://0.0.0.0:${port}/mcp`,
  );
  console.log(`Public URL: ${issuerUrl.href}`);
});
