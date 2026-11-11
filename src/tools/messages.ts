import { z } from "zod";
import {
  AttachmentError,
  type LoadedFile,
  loadAttachment,
} from "@/attachment.ts";
import type { RegisterFn } from "@/types.ts";

const accountId = z.number().describe("The account ID");
const conversationId = z.number().describe("The conversation ID");

export const register: RegisterFn = (server, client) => {
  const base = (aId: number, cId: number) =>
    `/api/v1/accounts/${aId}/conversations/${cId}/messages`;

  server.registerTool(
    "messages_list",
    {
      title: "List Messages",
      description: "List messages in a conversation",
      inputSchema: {
        account_id: accountId,
        conversation_id: conversationId,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ account_id, conversation_id }) => {
      const result = await client.get(base(account_id, conversation_id));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "messages_create",
    {
      title: "Send Message",
      description: "Send a message in a conversation",
      inputSchema: {
        account_id: accountId,
        conversation_id: conversationId,
        content: z.string().describe("Message content"),
        message_type: z
          .enum(["outgoing", "incoming"])
          .optional()
          .describe("Message type (default: outgoing)"),
        private: z
          .boolean()
          .optional()
          .describe("Whether this is a private/internal note"),
        content_type: z
          .enum(["text", "input_select", "cards", "form"])
          .optional()
          .describe("Content type"),
        content_attributes: z
          .record(z.string(), z.any())
          .optional()
          .describe("Content attributes for rich messages"),
      },
    },
    async ({ account_id, conversation_id, ...body }) => {
      const result = await client.post(base(account_id, conversation_id), body);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "messages_create_attachment",
    {
      title: "Enviar arquivo na conversa",
      description:
        "Envia um arquivo (PDF, imagem, áudio, vídeo, planilha etc.) numa conversa do Chatwoot, com legenda opcional. " +
        "Informe EXATAMENTE UMA fonte: `arquivo_url` (link http/https público; o servidor baixa o arquivo) " +
        "OU `arquivo_base64` (conteúdo em base64; nesse caso `nome_arquivo` é obrigatório, ex.: 'proposta.pdf'). " +
        "Limite de 40 MB. O tipo (mime) é deduzido pela extensão do nome se `mime_type` não vier. " +
        "Links para endereços internos/privados (localhost, 10.x, 192.168.x etc.) são recusados. " +
        "Use `private: true` para anexar como nota interna (o cliente não vê). Para mandar só texto, use messages_create.",
      inputSchema: {
        account_id: accountId,
        conversation_id: conversationId,
        arquivo_url: z
          .string()
          .optional()
          .describe(
            "URL http/https do arquivo para o servidor baixar (não use junto com arquivo_base64)",
          ),
        arquivo_base64: z
          .string()
          .optional()
          .describe(
            "Conteúdo do arquivo em base64 (aceita data URL). Exige nome_arquivo. Não use junto com arquivo_url",
          ),
        nome_arquivo: z
          .string()
          .optional()
          .describe(
            "Nome do arquivo com extensão, ex.: 'boleto.pdf'. Obrigatório com arquivo_base64; com URL, opcional (padrão: nome no fim da URL)",
          ),
        mime_type: z
          .string()
          .optional()
          .describe(
            "Tipo MIME, ex.: 'application/pdf'. Opcional: deduzido pela extensão",
          ),
        content: z
          .string()
          .optional()
          .describe("Legenda/texto que acompanha o arquivo (opcional)"),
        private: z
          .boolean()
          .optional()
          .describe(
            "true = nota interna (só a equipe vê); padrão false (vai para o cliente)",
          ),
      },
    },
    async ({
      account_id,
      conversation_id,
      content,
      private: isPrivate,
      ...src
    }) => {
      let file: LoadedFile;
      try {
        file = await loadAttachment(src);
      } catch (error) {
        if (error instanceof AttachmentError) {
          return {
            isError: true,
            content: [{ type: "text", text: error.message }],
          };
        }
        throw error;
      }
      const form = new FormData();
      if (content) form.append("content", content);
      form.append("message_type", "outgoing");
      form.append("private", String(isPrivate ?? false));
      form.append(
        "attachments[]",
        new File([file.bytes], file.name, { type: file.type }),
      );
      const result = await client.postForm(
        base(account_id, conversation_id),
        form,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "messages_delete",
    {
      title: "Delete Message",
      description: "Delete a message from a conversation",
      inputSchema: {
        account_id: accountId,
        conversation_id: conversationId,
        message_id: z.number().describe("Message ID"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ account_id, conversation_id, message_id }) => {
      await client.delete(`${base(account_id, conversation_id)}/${message_id}`);
      return {
        content: [{ type: "text", text: "Message deleted successfully" }],
      };
    },
  );
};
