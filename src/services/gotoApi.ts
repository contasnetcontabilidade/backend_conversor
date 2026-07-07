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

// Busca o relatorio pos-chamada por conversationSpaceId (contem a gravacao).
export async function getCallReport(
  conversationSpaceId: string,
): Promise<Record<string, unknown>> {
  // TODO-VALIDAR: confirmar o path exato do relatorio por conversationSpaceId.
  const response = await authedFetch(
    `${API_BASE}/call-events-report/v1/report-summaries/${encodeURIComponent(
      conversationSpaceId,
    )}`,
  );
  const payload = await readJson(response);
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

// Extrai a URL da gravacao do relatorio (procura em campos "recording").
export function extractRecordingUrl(
  report: Record<string, unknown>,
): string | null {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (isRecord(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (
          /recording/i.test(key) &&
          typeof value === "string" &&
          /^https?:\/\//.test(value)
        ) {
          found.push(value);
        } else if (
          typeof value === "string" &&
          /^https?:\/\//.test(value) &&
          /recording|\.wav|\.mp3/i.test(value)
        ) {
          found.push(value);
        } else {
          visit(value);
        }
      }
    }
  };
  visit(report);
  return found[0] ?? null;
}

// Baixa a gravacao para um arquivo temporario e devolve o caminho local.
export async function downloadRecording(recordingUrl: string): Promise<string> {
  const sameHostAsApi = (() => {
    try {
      return new URL(recordingUrl).host === new URL(API_BASE).host;
    } catch {
      return false;
    }
  })();

  const init: RequestInit = {};
  let response: Response;
  try {
    // URLs assinadas (S3) nao devem receber Authorization; so a API GoTo recebe.
    response = sameHostAsApi
      ? await authedFetch(recordingUrl, init)
      : await fetch(recordingUrl, init);
  } catch (error) {
    throw new AppError({
      statusCode: 502,
      code: "GOTO_RECORDING_DOWNLOAD_ERROR",
      message: `Falha ao baixar a gravacao: ${getErrorMessage(error)}`,
    });
  }

  if (!response.ok) {
    throw new AppError({
      statusCode: 502,
      code: "GOTO_RECORDING_DOWNLOAD_ERROR",
      message: `Falha ao baixar a gravacao (HTTP ${response.status}).`,
    });
  }

  const contentType = response.headers.get("content-type") || "";
  const ext = /mpeg|mp3/i.test(contentType)
    ? ".mp3"
    : /wav/i.test(contentType) || /\.wav/i.test(recordingUrl)
      ? ".wav"
      : ".mp3";

  const buffer = Buffer.from(await response.arrayBuffer());
  const filePath = path.join(
    os.tmpdir(),
    `goto-recording-${Date.now()}${ext}`,
  );
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}
