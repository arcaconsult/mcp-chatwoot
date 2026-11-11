/**
 * Loads a file for a Chatwoot message attachment, from base64 or from an
 * http(s) URL, with a size cap and SSRF protection (private/loopback hosts
 * are refused, including on every redirect hop).
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024; // 40 MB
export const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

export interface AttachmentInput {
  arquivo_url?: string;
  arquivo_base64?: string;
  nome_arquivo?: string;
  mime_type?: string;
}

export interface LoadedFile {
  bytes: Uint8Array;
  name: string;
  type: string;
}

export type HostLookup = (host: string) => Promise<string[]>;

export interface LoadOptions {
  lookup?: HostLookup;
  maxBytes?: number;
  timeoutMs?: number;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  "3gp": "video/3gpp",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
};

export function mimeFromName(name: string): string | undefined {
  const ext = name.toLowerCase().split(".").pop();
  return ext && ext !== name.toLowerCase() ? MIME_BY_EXT[ext] : undefined;
}

const sizeError = (maxBytes: number) =>
  new AttachmentError(
    `Arquivo maior que o limite de ${Math.round(maxBytes / 1024 / 1024)} MB.`,
  );

// ── Private address check ────────────────────────────────────────

function ipv4ToInt(ip: string): number {
  return (
    ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
  );
}

function inV4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
}

/** True for loopback, private, link-local and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return (
      inV4(n, "0.0.0.0", 8) ||
      inV4(n, "127.0.0.0", 8) ||
      inV4(n, "10.0.0.0", 8) ||
      inV4(n, "172.16.0.0", 12) ||
      inV4(n, "192.168.0.0", 16) ||
      inV4(n, "169.254.0.0", 16) ||
      inV4(n, "100.64.0.0", 10)
    );
  }
  if (family === 6) {
    if (ip === "::1" || ip === "::") return true;
    // IPv4-mapped (::ffff:a.b.c.d)
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    const first = Number.parseInt(ip.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
    return false;
  }
  return true; // not an IP: treat as unsafe
}

const defaultLookup: HostLookup = async (host) =>
  (await dnsLookup(host, { all: true })).map((r) => r.address);

async function assertPublicUrl(raw: string, lookup: HostLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AttachmentError(`URL inválida: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AttachmentError("A URL do arquivo precisa ser http ou https.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new AttachmentError(
      "URL recusada: aponta para endereço interno/privado.",
    );
  }
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new AttachmentError(`Não consegui resolver o host ${host}.`);
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new AttachmentError(
      "URL recusada: aponta para endereço interno/privado.",
    );
  }
  return url;
}

// ── Loaders ──────────────────────────────────────────────────────

function fromBase64(input: AttachmentInput, maxBytes: number): LoadedFile {
  const name = input.nome_arquivo?.trim();
  if (!name) {
    throw new AttachmentError(
      "nome_arquivo é obrigatório quando o arquivo vem em arquivo_base64.",
    );
  }
  // Accept data URLs ("data:...;base64,xxxx") and strip whitespace.
  const b64 = (input.arquivo_base64 ?? "")
    .replace(/^data:[^,]*,/, "")
    .replace(/\s+/g, "");
  if (Math.floor((b64.length * 3) / 4) > maxBytes + 2) {
    throw sizeError(maxBytes);
  }
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64) || b64.length === 0) {
    throw new AttachmentError("arquivo_base64 não é um base64 válido.");
  }
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.byteLength > maxBytes) throw sizeError(maxBytes);
  return {
    bytes,
    name,
    type: input.mime_type || mimeFromName(name) || "application/octet-stream",
  };
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw sizeError(maxBytes);
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw sizeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function fromUrl(
  input: AttachmentInput,
  opts: Required<LoadOptions>,
): Promise<LoadedFile> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let url = await assertPublicUrl(input.arquivo_url ?? "", opts.lookup);
  let response: Response;
  try {
    for (let hop = 0; ; hop++) {
      response = await fetch(url, { redirect: "manual", signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) break;
        if (hop >= MAX_REDIRECTS) {
          throw new AttachmentError("Redirecionamentos demais na URL.");
        }
        url = await assertPublicUrl(
          new URL(location, url).toString(),
          opts.lookup,
        );
        continue;
      }
      break;
    }
    if (!response.ok) {
      throw new AttachmentError(
        `Falha ao baixar o arquivo: HTTP ${response.status}.`,
      );
    }
    const bytes = await readCapped(response, opts.maxBytes);
    const fromPath = decodeURIComponent(
      url.pathname.split("/").pop() ?? "",
    ).trim();
    const name = input.nome_arquivo?.trim() || fromPath || "arquivo";
    const headerType = response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim();
    return {
      bytes,
      name,
      type:
        input.mime_type ||
        mimeFromName(name) ||
        headerType ||
        "application/octet-stream",
    };
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new AttachmentError(
        `Tempo esgotado ao baixar o arquivo (${opts.timeoutMs / 1000} s).`,
      );
    }
    throw new AttachmentError(
      `Falha ao baixar o arquivo: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Validates the input (exactly one source) and returns the file bytes. */
export async function loadAttachment(
  input: AttachmentInput,
  options: LoadOptions = {},
): Promise<LoadedFile> {
  const opts: Required<LoadOptions> = {
    lookup: options.lookup ?? defaultLookup,
    maxBytes: options.maxBytes ?? MAX_ATTACHMENT_BYTES,
    timeoutMs: options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
  };
  const hasUrl = Boolean(input.arquivo_url?.trim());
  const hasB64 = Boolean(input.arquivo_base64?.trim());
  if (hasUrl === hasB64) {
    throw new AttachmentError(
      "Informe exatamente uma fonte: arquivo_url OU arquivo_base64 (não as duas, nem nenhuma).",
    );
  }
  return hasB64 ? fromBase64(input, opts.maxBytes) : fromUrl(input, opts);
}
