import { describe, expect, mock, test } from "bun:test";
import { ChatwootClient } from "@/client.ts";
import { createServer } from "@/server.ts";

function setup() {
  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ status: "queued" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  // biome-ignore lint/suspicious/noExplicitAny: mock fetch override
  globalThis.fetch = fetchMock as any;
  const server = createServer(
    new ChatwootClient("https://chatwoot.example.com", "test-token"),
  );
  // biome-ignore lint/suspicious/noExplicitAny: accessing internal properties for testing
  const tools = (server as any)._registeredTools;
  const call = async (name: string, args: Record<string, unknown>) => {
    await tools[name].handler(args, {});
    const [url, init] = (fetchMock.mock.calls as unknown[][])[0] as [
      string,
      RequestInit,
    ];
    return {
      url: String(url),
      method: init.method,
      body: JSON.parse(String(init.body)),
    };
  };
  return { call };
}

describe("WhatsApp archive/mute tools", () => {
  test("conversations_whatsapp_archive posts the flag", async () => {
    const { call } = setup();
    const sent = await call("conversations_whatsapp_archive", {
      account_id: 2,
      conversation_id: 15,
      archive: false,
    });

    expect(sent.method).toBe("POST");
    expect(sent.url).toBe(
      "https://chatwoot.example.com/api/v1/accounts/2/conversations/15/whatsapp_archive",
    );
    expect(sent.body).toEqual({ archive: false });
  });

  test("conversations_whatsapp_mute defaults the duration to always", async () => {
    const { call } = setup();
    const sent = await call("conversations_whatsapp_mute", {
      account_id: 2,
      conversation_id: 15,
      mute: true,
    });

    expect(sent.url).toEndWith("/conversations/15/whatsapp_mute");
    expect(sent.body).toEqual({ mute: true, duration: "always" });
  });

  test("conversations_whatsapp_mute sends no duration on unmute", async () => {
    const { call } = setup();
    const sent = await call("conversations_whatsapp_mute", {
      account_id: 2,
      conversation_id: 15,
      mute: false,
      duration: "8h",
    });

    expect(sent.body).toEqual({ mute: false });
  });
});
