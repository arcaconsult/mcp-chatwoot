import { describe, expect, mock, test } from "bun:test";
import {
  AttachmentError,
  isPrivateAddress,
  loadAttachment,
  MAX_ATTACHMENT_BYTES,
} from "@/attachment.ts";
import { ChatwootClient } from "@/client.ts";
import { createServer } from "@/server.ts";

const CHATWOOT = "https://chatwoot.example.com";
const PUBLIC_FILE_URL = "https://93.184.216.34/docs/proposta.pdf";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 teste");

type Handler = (url: string, init?: RequestInit) => Response;

function setup(handler?: Handler) {
  const fetchMock = mock((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (handler && !url.startsWith(CHATWOOT)) {
      return Promise.resolve(handler(url, init));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ id: 99 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  // biome-ignore lint/suspicious/noExplicitAny: mock fetch override
  globalThis.fetch = fetchMock as any;
  const server = createServer(new ChatwootClient(CHATWOOT, "test-token"));
  // biome-ignore lint/suspicious/noExplicitAny: accessing internal properties for testing
  const tools = (server as any)._registeredTools;
  const call = (args: Record<string, unknown>) =>
    tools.messages_create_attachment.handler(
      { account_id: 2, conversation_id: 15, ...args },
      {},
    ) as Promise<{ isError?: boolean; content: { text: string }[] }>;
  const chatwootCall = () => {
    const found = (fetchMock.mock.calls as unknown[][]).find((c) =>
      String(c[0]).startsWith(CHATWOOT),
    );
    return found as [string, RequestInit] | undefined;
  };
  return { call, fetchMock, chatwootCall };
}

describe("messages_create_attachment", () => {
  test("base64: envia multipart com attachments[], nome e tipo", async () => {
    const { call, chatwootCall } = setup();
    const res = await call({
      arquivo_base64: Buffer.from(PDF_BYTES).toString("base64"),
      nome_arquivo: "proposta.pdf",
      content: "Segue a proposta",
    });

    expect(res.isError).toBeUndefined();
    const sent = chatwootCall();
    expect(sent).toBeDefined();
    const [url, init] = sent as [string, RequestInit];
    expect(url).toBe(`${CHATWOOT}/api/v1/accounts/2/conversations/15/messages`);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Api-Access-Token")).toBe("test-token");
    expect(headers.get("Content-Type")).toBeNull();

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("content")).toBe("Segue a proposta");
    expect(form.get("message_type")).toBe("outgoing");
    expect(form.get("private")).toBe("false");
    const file = form.get("attachments[]") as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("proposta.pdf");
    expect(file.type).toBe("application/pdf");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF_BYTES);
  });

  test("URL: baixa o arquivo e envia", async () => {
    const { call, chatwootCall, fetchMock } = setup(
      () =>
        new Response(PDF_BYTES, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
    );
    const res = await call({ arquivo_url: PUBLIC_FILE_URL, private: true });

    expect(res.isError).toBeUndefined();
    expect(fetchMock.mock.calls.length).toBe(2);
    const form = (chatwootCall() as [string, RequestInit])[1].body as FormData;
    expect(form.get("private")).toBe("true");
    expect(form.has("content")).toBe(false);
    const file = form.get("attachments[]") as File;
    expect(file.name).toBe("proposta.pdf");
    expect(file.type).toBe("application/pdf");
    expect(file.size).toBe(PDF_BYTES.byteLength);
  });

  test("as duas fontes → erro", async () => {
    const { call, chatwootCall } = setup();
    const res = await call({
      arquivo_url: PUBLIC_FILE_URL,
      arquivo_base64: "AAAA",
      nome_arquivo: "x.pdf",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("exatamente uma fonte");
    expect(chatwootCall()).toBeUndefined();
  });

  test("nenhuma fonte → erro", async () => {
    const { call, chatwootCall } = setup();
    const res = await call({ content: "só legenda" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("exatamente uma fonte");
    expect(chatwootCall()).toBeUndefined();
  });

  test("base64 sem nome_arquivo → erro", async () => {
    const { call } = setup();
    const res = await call({ arquivo_base64: "AAAA" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("nome_arquivo");
  });

  test("base64 maior que 40 MB → erro", async () => {
    const { call, chatwootCall } = setup();
    const res = await call({
      arquivo_base64: "A".repeat(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 8),
      nome_arquivo: "grande.bin",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("40 MB");
    expect(chatwootCall()).toBeUndefined();
  });

  test("URL com arquivo maior que 40 MB → erro", async () => {
    const { call, chatwootCall } = setup(
      () =>
        new Response("x", {
          status: 200,
          headers: { "Content-Length": String(MAX_ATTACHMENT_BYTES + 1) },
        }),
    );
    const res = await call({ arquivo_url: PUBLIC_FILE_URL });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("40 MB");
    expect(chatwootCall()).toBeUndefined();
  });

  test("URL para 127.0.0.1 → recusada sem baixar", async () => {
    const { call, fetchMock } = setup(() => new Response("segredo"));
    const res = await call({ arquivo_url: "http://127.0.0.1:8080/x.pdf" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("interno/privado");
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("redirecionamento para IP privado → recusado", async () => {
    const { call, fetchMock } = setup(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data" },
        }),
    );
    const res = await call({ arquivo_url: PUBLIC_FILE_URL });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("interno/privado");
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  test("URL que não é http(s) → recusada", async () => {
    const { call } = setup();
    const res = await call({ arquivo_url: "file:///etc/passwd" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("http ou https");
  });
});

describe("loadAttachment", () => {
  test("host que resolve para IP privado → recusado", async () => {
    const lookup = mock(() => Promise.resolve(["10.1.2.3"]));
    await expect(
      loadAttachment(
        { arquivo_url: "https://interno.example.com/a.pdf" },
        {
          lookup,
        },
      ),
    ).rejects.toBeInstanceOf(AttachmentError);
    expect(lookup).toHaveBeenCalledWith("interno.example.com");
  });

  test("mime_type explícito tem prioridade sobre a extensão", async () => {
    const file = await loadAttachment({
      arquivo_base64: "AAAA",
      nome_arquivo: "audio.ogg",
      mime_type: "audio/ogg; codecs=opus",
    });
    expect(file.type).toBe("audio/ogg; codecs=opus");
  });

  test("isPrivateAddress cobre as faixas pedidas", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of [
      "8.8.8.8",
      "172.32.0.1",
      "93.184.216.34",
      "2606:4700::1",
    ]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });
});
