import { AppError } from "../lib/errors";
import { getValidAccessToken } from "./gmailAuth";

// Cliente REST do Gmail (somente leitura). Lista os e-mails com o marcador
// configurado e busca o corpo em texto de um e-mail. Tudo por usuario (e-mail).

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

function labelQuery(): string {
  const label = (process.env.GMAIL_LABEL || "Chamado").trim() || "Chamado";
  return `label:"${label}"`; // aspas suportam rotulos com espaco
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function gmailGet(email: string, path: string): Promise<any> {
  const token = await getValidAccessToken(email);
  const resp = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await resp.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!resp.ok) {
    throw new AppError({
      statusCode: resp.status === 401 || resp.status === 403 ? 401 : 502,
      code: "GMAIL_API_ERROR",
      message: `Falha na API do Gmail (HTTP ${resp.status}).`,
      details: payload,
    });
  }
  return payload;
}

export interface EmailResumo {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface EmailCompleto extends EmailResumo {
  fromNome: string;
  fromEmail: string;
  corpo: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function header(headers: any[], nome: string): string {
  const h = (headers || []).find(
    (x) => String(x?.name || "").toLowerCase() === nome.toLowerCase(),
  );
  return h ? String(h.value || "") : "";
}

function decodeB64Url(data: string): string {
  try {
    return Buffer.from(
      String(data || "")
        .replace(/-/g, "+")
        .replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
  } catch {
    return "";
  }
}

// Extrai o corpo em texto puro (prefere text/plain; senao faz strip do HTML).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extrairCorpo(payload: any): string {
  if (!payload) return "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buscar = (part: any, mime: string): string => {
    if (!part) return "";
    if (part.mimeType === mime && part.body?.data) {
      return decodeB64Url(part.body.data);
    }
    for (const sub of part.parts || []) {
      const r = buscar(sub, mime);
      if (r) return r;
    }
    return "";
  };
  const texto = buscar(payload, "text/plain");
  if (texto.trim()) return texto.trim();
  const html = buscar(payload, "text/html");
  if (html.trim()) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }
  if (payload.body?.data) return decodeB64Url(payload.body.data).trim();
  return "";
}

function parseFrom(from: string): { nome: string; email: string } {
  const m = String(from || "").match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { nome: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { nome: "", email: String(from || "").trim().toLowerCase() };
}

// Lista os e-mails com o marcador configurado (mais recentes primeiro).
export async function listarEmailsMarcados(
  email: string,
  limite = 25,
): Promise<EmailResumo[]> {
  const max = Math.min(Math.max(limite, 1), 50);
  const q = encodeURIComponent(labelQuery());
  const lista = await gmailGet(email, `/messages?q=${q}&maxResults=${max}`);
  const ids: Array<{ id: string; threadId: string }> = Array.isArray(
    lista?.messages,
  )
    ? lista.messages
    : [];

  return Promise.all(
    ids.map(async (it) => {
      const msg = await gmailGet(
        email,
        `/messages/${encodeURIComponent(
          it.id,
        )}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      );
      const headers = msg?.payload?.headers || [];
      return {
        id: String(msg?.id || it.id),
        threadId: String(msg?.threadId || it.threadId || ""),
        from: header(headers, "From"),
        subject: header(headers, "Subject"),
        date: header(headers, "Date"),
        snippet: String(msg?.snippet || ""),
      } as EmailResumo;
    }),
  );
}

// Busca um e-mail completo (com o corpo em texto).
export async function obterEmail(
  email: string,
  messageId: string,
): Promise<EmailCompleto> {
  const msg = await gmailGet(
    email,
    `/messages/${encodeURIComponent(messageId)}?format=full`,
  );
  const headers = msg?.payload?.headers || [];
  const from = header(headers, "From");
  const { nome, email: fromEmail } = parseFrom(from);
  return {
    id: String(msg?.id || messageId),
    threadId: String(msg?.threadId || ""),
    from,
    fromNome: nome,
    fromEmail,
    subject: header(headers, "Subject"),
    date: header(headers, "Date"),
    snippet: String(msg?.snippet || ""),
    corpo: extrairCorpo(msg?.payload),
  };
}
