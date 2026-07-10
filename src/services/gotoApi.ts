import fs from "fs";
import os from "os";
import path from "path";
import { AppError, getErrorMessage, isRecord } from "../lib/errors";
import { getValidAccessToken } from "./gotoAuth";
import {
  getAccountKey,
  getChannelId,
  saveAccountKey,
  saveChannelId,
} from "./store";

// Cliente da API GoTo Connect: cria o canal de webhook + subscription de eventos
// de chamada, busca o relatorio pos-chamada e baixa a gravacao.
// Docs: developer.goto.com/guides/GoToConnect/{14,15,16}_*
//
// ATENCAO: o endpoint/forma exata de download da gravacao e do relatorio por
// conversationSpaceId nao sao 100% documentados publicamente e devem ser
// validados contra a conta real (marcados com TODO-VALIDAR).

const API_BASE = process.env.GOTO_API_BASE || "https://api.goto.com";
const CHANNEL_NICKNAME =
  process.env.GOTO_CHANNEL_NICKNAME || "conversor-call-events";

async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getValidAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(url, { ...init, headers });
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

// [DIAGNOSTICO] Busca o cartao de um contato da agenda GoTo pelo id (a empresa/
// CNPJ ficam aqui, nao na ligacao). Nao lanca: devolve status + corpo para
// inspecao. Sera removido/convertido apos definirmos o padrao de cadastro.
export async function getContatoGotoDiag(
  contactId: string,
): Promise<{ status: number; body: unknown }> {
  const resp = await authedFetch(
    `${API_BASE}/contacts/v1/contacts/${encodeURIComponent(contactId)}`,
  );
  const body = await readJson(resp);
  return { status: resp.status, body };
}

// Resolve o accountKey (super-admin) — do env ou via Admin API /me.
export async function resolveAccountKey(): Promise<string> {
  const fromEnv = process.env.GOTO_ACCOUNT_KEY;
  if (fromEnv) return fromEnv;

  const cached = await getAccountKey();
  if (cached) return cached;

  // TODO-VALIDAR: confirmar o endpoint /me e o campo do accountKey na conta real.
  const response = await authedFetch(`${API_BASE}/admin/rest/v1/me`);
  const payload = await readJson(response);
  if (!response.ok || !isRecord(payload)) {
    throw new AppError({
      statusCode: 502,
      code: "GOTO_ACCOUNTKEY_ERROR",
      message:
        "Nao foi possivel resolver o accountKey. Defina GOTO_ACCOUNT_KEY no ambiente.",
      details: payload,
    });
  }

  const accounts = (payload as Record<string, unknown>).accounts;
  let accountKey: string | undefined;
  if (Array.isArray(accounts) && accounts.length > 0 && isRecord(accounts[0])) {
    accountKey = String(
      accounts[0].accountKey ?? accounts[0].key ?? accounts[0].id ?? "",
    );
  }
  if (!accountKey) {
    throw new AppError({
      statusCode: 502,
      code: "GOTO_ACCOUNTKEY_ERROR",
      message: "accountKey ausente na resposta. Defina GOTO_ACCOUNT_KEY.",
      details: payload,
    });
  }

  await saveAccountKey(accountKey);
  return accountKey;
}

// Cria (ou garante) um canal de notificacao via webhook e devolve o channelId.
async function ensureWebhookChannel(webhookUrl: string): Promise<string> {
  const response = await authedFetch(
    `${API_BASE}/notification-channel/v1/channels/${encodeURIComponent(
      CHANNEL_NICKNAME,
    )}`,
    {
      method: "POST",
      body: JSON.stringify({
        channelType: "Webhook",
        webhookChannelData: { webhook: { url: webhookUrl } },
      }),
    },
  );

  const payload = await readJson(response);
  if (!response.ok || !isRecord(payload) || !payload.channelId) {
    throw new AppError({
      statusCode: 502,
      code: "GOTO_CHANNEL_ERROR",
      message: `Falha ao criar canal de notificacao (HTTP ${response.status}).`,
      details: payload,
    });
  }

  const channelId = String(payload.channelId);
  await saveChannelId(channelId);
  return channelId;
}

// Assina os eventos de chamada (STARTING/ENDING) e o relatorio pos-chamada.
async function subscribeCallEvents(
  channelId: string,
  accountKey: string,
): Promise<void> {
  const response = await authedFetch(
    `${API_BASE}/call-events/v1/subscriptions`,
    {
      method: "POST",
      body: JSON.stringify({
        channelId,
        accountKeys: [{ id: accountKey, events: ["STARTING", "ENDING"] }],
      }),
    },
  );

  // 207 Multi-Status e o sucesso esperado desta chamada.
  if (!response.ok && response.status !== 207) {
    const payload = await readJson(response);
    throw new AppError({
      statusCode: 502,
      code: "GOTO_SUBSCRIBE_ERROR",
      message: `Falha ao assinar eventos de chamada (HTTP ${response.status}).`,
      details: payload,
    });
  }
}

// Orquestra canal + subscription. Chamado apos o OAuth do super-admin.
export async function setupCallEventsSubscription(
  webhookUrl: string,
): Promise<{ channelId: string; accountKey: string }> {
  const accountKey = await resolveAccountKey();
  const channelId = await ensureWebhookChannel(webhookUrl);
  await subscribeCallEvents(channelId, accountKey);
  return { channelId, accountKey };
}

// Busca o relatorio COMPLETO da chamada por conversationSpaceId.
// Esse relatorio traz participants[].recordings[].id (o recordingId).
export async function getCallReport(
  conversationSpaceId: string,
): Promise<Record<string, unknown>> {
  const response = await authedFetch(
    `${API_BASE}/call-events-report/v1/reports/${encodeURIComponent(
      conversationSpaceId,
    )}`,
  );
  const payload = await readJson(response);

  if (response.status === 404) {
    throw new AppError({
      statusCode: 404,
      code: "REPORT_NOT_READY",
      message:
        "Relatorio da chamada ainda nao disponivel. Tente novamente em instantes.",
    });
  }
  if (!response.ok || !isRecord(payload)) {
    throw new AppError({
      statusCode: 502,
      code: "GOTO_REPORT_ERROR",
      message: `Falha ao buscar relatorio da chamada (HTTP ${response.status}).`,
      details: payload,
    });
  }
  return payload as Record<string, unknown>;
}

export interface HistoricoChamadaItem {
  legId: string;
  direction: string; // INBOUND | OUTBOUND
  startTime: string;
  durationSeg: number;
  interno: boolean;
  contatoNumero: string; // o outro lado (nao o ramal consultado)
  contatoNome: string;
}

// Lista as ultimas chamadas do GoTo para um ramal (call-history API).
// Atencao: os itens NAO trazem conversationSpaceId (so legId), entao servem
// para EXIBIR o historico; abrir chamado exige o id vindo do evento em tempo real.
export async function listarHistoricoChamadas(
  ramal: string,
  limit = 15,
): Promise<HistoricoChamadaItem[]> {
  const acct = process.env.GOTO_ACCOUNT_KEY || "";
  const pageSize = Math.min(Math.max(limit, 1), 50);
  const params = new URLSearchParams({ accountKey: acct, pageSize: String(pageSize) });
  if (ramal) params.set("extension", ramal);

  const response = await authedFetch(
    `${API_BASE}/call-history/v1/calls?${params.toString()}`,
  );
  const payload = await readJson(response);
  if (!response.ok || !isRecord(payload)) {
    throw new AppError({
      statusCode: 502,
      code: "GOTO_HISTORY_ERROR",
      message: `Falha ao buscar historico de chamadas (HTTP ${response.status}).`,
      details: isRecord(payload) ? payload : undefined,
    });
  }
  const items = Array.isArray(payload.items) ? payload.items : [];
  const ehExtensao = (n: unknown) => /^\d{2,5}$/.test(String(n ?? ""));

  return items.filter(isRecord).map((it) => {
    const caller = isRecord(it.caller) ? it.caller : {};
    const callee = isRecord(it.callee) ? it.callee : {};
    const direction = String(it.direction || "").toUpperCase();
    const outro = direction === "OUTBOUND" ? callee : caller;
    const durMs = typeof it.duration === "number" ? it.duration : 0;
    return {
      legId: String(it.legId || ""),
      direction,
      startTime: String(it.startTime || ""),
      durationSeg: Math.round(durMs / 1000),
      interno: ehExtensao(caller.number) && ehExtensao(callee.number),
      contatoNumero: String((outro as Record<string, unknown>).number || ""),
      contatoNome: String((outro as Record<string, unknown>).name || ""),
    };
  });
}

// Extrai o recordingId do relatorio (participants[].recordings[].id).
export function extractRecordingId(
  report: Record<string, unknown>,
): string | null {
  const participants = report.participants;
  if (!Array.isArray(participants)) return null;
  for (const p of participants) {
    if (isRecord(p) && Array.isArray(p.recordings)) {
      for (const rec of p.recordings) {
        if (isRecord(rec) && typeof rec.id === "string" && rec.id) {
          return rec.id;
        }
      }
    }
  }
  return null;
}

// Baixa a gravacao (fluxo em 2 passos, com o token no PATH):
//  1) GET .../recordings/{id}/content        -> { token, status }
//  2) GET .../recordings/{id}/content/{token} -> bytes do audio (MP3)
export async function downloadRecording(recordingId: string): Promise<string> {
  // 1) token de acesso a gravacao
  const tokenRes = await authedFetch(
    `${API_BASE}/recording/v1/recordings/${encodeURIComponent(
      recordingId,
    )}/content`,
  );
  const tokenPayload = await readJson(tokenRes);
  if (!tokenRes.ok || !isRecord(tokenPayload)) {
    throw new AppError({
      statusCode: 502,
      code: "GOTO_RECORDING_TOKEN_ERROR",
      message: `Falha ao obter token da gravacao (HTTP ${tokenRes.status}).`,
      details: tokenPayload,
    });
  }
  const status = String((tokenPayload as Record<string, unknown>).status || "");
  const tokenObj = (tokenPayload as Record<string, unknown>).token;
  const token = isRecord(tokenObj) ? String(tokenObj.token || "") : "";
  if (!token || status !== "UPLOADED") {
    throw new AppError({
      statusCode: 404,
      code: "RECORDING_NOT_READY",
      message: `Gravacao ainda nao disponivel (status ${status || "?"}).`,
    });
  }

  // 2) baixa o audio (token no path)
  let mediaRes: Response;
  try {
    mediaRes = await authedFetch(
      `${API_BASE}/recording/v1/recordings/${encodeURIComponent(
        recordingId,
      )}/content/${encodeURIComponent(token)}`,
    );
  } catch (error) {
    throw new AppError({
      statusCode: 502,
      code: "GOTO_RECORDING_DOWNLOAD_ERROR",
      message: `Falha ao baixar a gravacao: ${getErrorMessage(error)}`,
    });
  }
  if (!mediaRes.ok) {
    throw new AppError({
      statusCode: 502,
      code: "GOTO_RECORDING_DOWNLOAD_ERROR",
      message: `Falha ao baixar a gravacao (HTTP ${mediaRes.status}).`,
    });
  }

  const contentType = mediaRes.headers.get("content-type") || "";
  // Formato padrao das gravacoes GoTo e MP3 (o content-type vem octet-stream).
  const ext = /wav/i.test(contentType) ? ".wav" : ".mp3";
  const buffer = Buffer.from(await mediaRes.arrayBuffer());
  const filePath = path.join(os.tmpdir(), `goto-recording-${Date.now()}${ext}`);
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}
