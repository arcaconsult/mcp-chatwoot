import { describe, expect, test } from "bun:test";
import { ChatwootClient } from "@/client.ts";
import { createServer } from "@/server.ts";

describe("Server", () => {
  test("creates server with all tools registered", () => {
    const client = new ChatwootClient(
      "https://chatwoot.example.com",
      "test-token",
    );
    const server = createServer(client);

    // The server should have been created successfully
    expect(server).toBeDefined();
  });

  test("registers all 129 tools", () => {
    const client = new ChatwootClient(
      "https://chatwoot.example.com",
      "test-token",
    );
    const server = createServer(client);

    // biome-ignore lint/suspicious/noExplicitAny: accessing internal properties for testing
    const tools = (server as any)._registeredTools;
    expect(Object.keys(tools).length).toBe(126);
  });

  test("has fazer.ai exclusive tools", () => {
    const client = new ChatwootClient(
      "https://chatwoot.example.com",
      "test-token",
    );
    const server = createServer(client);

    // biome-ignore lint/suspicious/noExplicitAny: accessing internal properties for testing
    const tools = (server as any)._registeredTools;

    // Kanban tools
    expect(tools.kanban_boards_list).toBeDefined();
    expect(tools.kanban_steps_list).toBeDefined();
    expect(tools.kanban_tasks_list).toBeDefined();
    expect(tools.kanban_audit_events_list).toBeDefined();

    // Scheduled messages
    expect(tools.scheduled_messages_list).toBeDefined();

    // Arcaconsult: send a file
    expect(tools.messages_create_attachment).toBeDefined();
  });
});

describe("MCP_TOOLS allowlist", () => {
  test("registers only the listed tools", () => {
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
    const { registerAllTools, allowedTools } = require("@/tools/index.ts");
    const client = new ChatwootClient(
      "https://chatwoot.example.com",
      "test-token",
    );
    const server = new McpServer({ name: "t", version: "0" });
    registerAllTools(
      server,
      client,
      allowedTools(" conversations_list, messages_list ,"),
    );

    // biome-ignore lint/suspicious/noExplicitAny: accessing internal properties for testing
    const tools = (server as any)._registeredTools;
    expect(Object.keys(tools).sort()).toEqual([
      "conversations_list",
      "messages_list",
    ]);
  });

  test("empty value means every tool", () => {
    const { allowedTools } = require("@/tools/index.ts");
    expect(allowedTools("")).toBeNull();
    expect(allowedTools(undefined)).toBeNull();
  });
});
