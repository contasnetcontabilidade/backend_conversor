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
  return extractRecordingIds(report)[0] ?? null;
}

// Participante da chamada, montado das DUAS fontes do relatorio.
//
// `report.participants` NAO e confiavel sozinho: numa ligacao real de fila com
// transferencia, 2 dos 3 atendentes (com gravacao!) simplesmente nao estavam
// nessa lista — apareciam apenas dentro de `report.callStates`. Quem atende e
// transfere tende a sumir de `participants`. Ler so dali fazia o sistema perder
// atendentes E gravacoes.
export interface ParticipanteRelatorio {
  id: string;
  ramal: string;
  nome: string;
  /** Gravacoes deste participante (de qualquer uma das fontes). */
  recordings: Record<string, unknown>[];
  /** Status vistos em callStates: RINGING, CONNECTED, DISCONNECTING... */
  status: Set<string>;
  /** O objeto mais completo que encontramos, para diagnostico. */
  bruto: Record<string, unknown>;
}

// Retorna boolean simples (e nao um type predicate): como o parametro ja e um
// Record, o predicate fazia o TypeScript inferir `never` no ramo do else.
function ehLinha(p: unknown): boolean {
  return (
    isRecord(p) &&
    isRecord(p.type) &&
    p.type.value === "LINE" &&
    typeof p.type.extensionNumber === "string" &&
    !!p.type.extensionNumber
  );
}

function gravacoesDe(p: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(p.recordings) ? p.recordings.filter(isRecord) : [];
}

/**
 * TODOS os participantes-ramal da chamada, unindo `participants` e os que so
 * aparecem em `callStates`. Deduplicado por id do participante; gravacoes e
 * status sao acumulados de todas as aparicoes.
 */
export function participantesDoRelatorio(
  report: Record<string, unknown>,
): ParticipanteRelatorio[] {
  const porId = new Map<string, ParticipanteRelatorio>();

  // Participante sem `id` ainda conta. Ele nao pode ser correlacionado com os
  // eventos de callStates (que casam por id), mas descarta-lo perderia um
  // atendente inteiro — e relatorio pobre e justamente onde o sistema precisa
  // degradar bem. A chave sintetica so serve para nao juntar dois numa so.
  let semId = 0;
  const registrar = (p: Record<string, unknown>, status?: string, exigirId = false) => {
    if (!ehLinha(p)) return;
    const temId = typeof p.id === "string" && !!p.id;
    if (!temId && exigirId) return; // em callStates, sem id nao da para acumular
    const chave = temId
      ? (p.id as string)
      : `sem-id:${String((p.type as Record<string, unknown>).extensionNumber)}:${semId++}`;
    const tipo = p.type as Record<string, unknown>;
    const atual =
      porId.get(chave) ||
      ({
        id: chave,
        ramal: String(tipo.extensionNumber || ""),
        nome: typeof tipo.name === "string" ? tipo.name : "",
        recordings: [],
        status: new Set<string>(),
        bruto: p,
      } as ParticipanteRelatorio);

    // Gravacoes: acumula sem repetir (o mesmo id pode vir em varios eventos).
    for (const rec of gravacoesDe(p)) {
      const idRec = typeof rec.id === "string" ? rec.id : "";
      if (!idRec || atual.recordings.some((r) => r.id === idRec)) continue;
      atual.recordings.push(rec);
    }
    if (status) atual.status.add(status.toUpperCase());
    // Fica com o objeto que tiver mais informacao.
    if (Object.keys(p).length > Object.keys(atual.bruto).length) atual.bruto = p;
    if (!atual.nome && typeof tipo.name === "string") atual.nome = tipo.name;

    porId.set(chave, atual);
  };

  // 1) a lista declarada (pode estar incompleta, mas define a ordem base)
  if (Array.isArray(report.participants)) {
    for (const p of report.participants) registrar(p as Record<string, unknown>);
  }
  // 2) a linha do tempo — e onde os atendentes que transferiram aparecem
  if (Array.isArray(report.callStates)) {
    for (const ev of report.callStates) {
      if (!isRecord(ev) || !Array.isArray(ev.participants)) continue;
      for (const pp of ev.participants) {
        if (!isRecord(pp)) continue;
        const st = isRecord(pp.status) ? String(pp.status.value || "") : "";
        // No relatorio real cada participante do evento vem com o `type`
        // completo, e o registrar() monta a linha sozinho. Mas o evento tambem
        // pode trazer so `{id, status}` — nesse caso o id ainda serve para
        // anexar o status a um participante ja conhecido.
        if (ehLinha(pp)) {
          registrar(pp, st || undefined, true);
          continue;
        }
        if (!st || typeof pp.id !== "string") continue;
        const jaVisto = porId.get(pp.id);
        if (jaVisto) jaVisto.status.add(st.toUpperCase());
      }
    }
  }

  return [...porId.values()];
}

// Um trecho de gravacao com TUDO que o relatorio disse sobre ele.
//
// Antes esta leitura devolvia so o `rec.id` e jogava fora o resto — inclusive o
// vinculo com o participante dono. Era por isso que nao dava para identificar a
// transferencia nem saber qual trecho e o principal: a informacao vinha no
// relatorio e era destruida aqui, nao no GoTo.
export interface TrechoGravacao {
  id: string;
  /** Posicao na lista — e o `i` que a rota do player usa. */
  indice: number;
  /** Ramal e nome do participante dono deste trecho (a "leg" da chamada). */
  ramal: string;
  nome: string;
  /** Duracao em segundos, se o relatorio informar (ou der para derivar). */
  duracaoSeg: number | null;
  /** De onde a duracao veio — entra no log para auditoria. */
  duracaoFonte: string;
  /** O relatorio marcou este trecho como o principal? */
  principalMarcado: boolean;
  /** Objeto cru do recording, para diagnostico. */
  bruto: Record<string, unknown>;
}

const CAMPOS_DURACAO_SEG = [
  "duration",
  "durationSeconds",
  "durationSec",
  "lengthSeconds",
  "recordingDuration",
];
const CAMPOS_DURACAO_MS = ["durationMs", "durationMillis", "lengthMs"];
const CAMPOS_PRINCIPAL = ["primary", "isPrimary", "main", "isMain"];

function numeroDe(obj: Record<string, unknown>, chaves: string[]): number | null {
  for (const k of chaves) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
      const n = Number(v);
      if (n > 0) return n;
    }
  }
  return null;
}

// A duracao pode vir em segundos, em milissegundos ou so como par de
// timestamps. Tentamos as tres, nesta ordem, e registramos qual venceu.
function duracaoDoRecording(rec: Record<string, unknown>): {
  seg: number | null;
  fonte: string;
} {
  // `duration` as vezes vem em ms mesmo sem o sufixo no nome. Um valor absurdo
  // para segundos (> 6h) quase certamente e ms — testado ANTES da leitura em
  // segundos, senao 900000ms viraria "250 horas de ligacao".
  const bruto = rec.duration;
  if (typeof bruto === "number" && bruto > 21600) {
    return { seg: Math.round(bruto / 1000), fonte: "duration tratado como ms" };
  }

  const seg = numeroDe(rec, CAMPOS_DURACAO_SEG);
  if (seg !== null) return { seg, fonte: "campo de segundos" };

  const ms = numeroDe(rec, CAMPOS_DURACAO_MS);
  if (ms !== null) {
    return { seg: Math.round(ms / 1000), fonte: "campo de milissegundos" };
  }

  const ini = rec.startTime ?? rec.startedAt ?? rec.start;
  const fim = rec.endTime ?? rec.endedAt ?? rec.end;
  if (typeof ini === "string" && typeof fim === "string") {
    const a = Date.parse(ini);
    const b = Date.parse(fim);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      return { seg: Math.round((b - a) / 1000), fonte: "diferenca de timestamps" };
    }
  }
  return { seg: null, fonte: "nao informada" };
}

// TODOS os trechos de gravacao do relatorio, na ordem dos participantes, sem
// repetir. Numa transferencia a chamada e gravada em VARIOS trechos (um por
// atendente) — as "legs" da chamada.
export function extractRecordings(
  report: Record<string, unknown>,
): TrechoGravacao[] {
  const trechos: TrechoGravacao[] = [];
  const seen = new Set<string>();
  // participantesDoRelatorio (e nao report.participants): numa fila com
  // transferencia, gravacoes de quem atendeu e passou adiante so aparecem em
  // callStates. Lendo so a lista declarada, esses trechos eram perdidos.
  for (const p of participantesDoRelatorio(report)) {
    for (const rec of p.recordings) {
      const id = typeof rec.id === "string" ? rec.id : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const { seg, fonte } = duracaoDoRecording(rec);
      trechos.push({
        id,
        indice: trechos.length,
        ramal: p.ramal,
        nome: p.nome,
        duracaoSeg: seg,
        duracaoFonte: fonte,
        principalMarcado: CAMPOS_PRINCIPAL.some((k) => rec[k] === true),
        bruto: rec,
      });
    }
  }
  return trechos;
}

// Compatibilidade: quem so precisa dos ids continua chamando isto.
export function extractRecordingIds(report: Record<string, unknown>): string[] {
  return extractRecordings(report).map((t) => t.id);
}

export interface EscolhaTrecho {
  indice: number;
  criterio: string;
}

// Escolhe o trecho principal SO com o que o relatorio ja informou — sem baixar
// nada. Devolve null quando o relatorio nao decide: ai quem chama precisa medir
// os arquivos (ver escolherPorTamanho no controller do preview).
export function escolherTrechoPeloRelatorio(
  trechos: TrechoGravacao[],
): EscolhaTrecho | null {
  if (trechos.length === 0) return null;
  if (trechos.length === 1) return { indice: 0, criterio: "trecho unico" };

  const marcados = trechos.filter((t) => t.principalMarcado);
  if (marcados.length === 1) {
    return {
      indice: marcados[0].indice,
      criterio: "marcado como principal no relatorio",
    };
  }

  const comDuracao = trechos.filter((t) => t.duracaoSeg !== null);
  if (comDuracao.length === trechos.length) {
    const maior = comDuracao.reduce((a, b) =>
      (b.duracaoSeg as number) > (a.duracaoSeg as number) ? b : a,
    );
    // Empate entre TODOS (todas as duracoes iguais) nao e uma escolha de
    // verdade: cai para a medicao por tamanho, que desempata de fato.
    const distintas = new Set(comDuracao.map((t) => t.duracaoSeg));
    if (distintas.size > 1) {
      return {
        indice: maior.indice,
        criterio: `maior duracao do relatorio (${maior.duracaoSeg}s, ${maior.duracaoFonte})`,
      };
    }
  }
  return null;
}

// Resumo de uma linha por trecho, para o log. Existe porque nao sabemos de
// antemao quais campos a conta real devolve: a primeira ligacao com
// transferencia mostra no log exatamente o que veio, e ai da para afinar
// CAMPOS_DURACAO_* / CAMPOS_PRINCIPAL sem adivinhacao.
export function descreverTrechos(trechos: TrechoGravacao[]): string {
  return trechos
    .map(
      (t) =>
        `#${t.indice} id=${t.id.slice(0, 8)} ramal=${t.ramal || "?"} ` +
        `nome="${t.nome}" dur=${t.duracaoSeg ?? "?"}s(${t.duracaoFonte})` +
        `${t.principalMarcado ? " [marcado principal]" : ""} ` +
        `campos=[${Object.keys(t.bruto).join(",")}]`,
    )
    .join(" | ");
}

// Baixa a gravacao (fluxo em 2 passos, com o token no PATH):
//  1) GET .../recordings/{id}/content        -> { token, status }
//  2) GET .../recordings/{id}/content/{token} -> bytes do audio (MP3)
// Abre a gravacao no GoTo e devolve a RESPOSTA (nao consome o corpo) + extensao.
// Usado tanto para transcrever (baixa para tmp) quanto para streamar o download
// ao usuario sem bufferizar tudo (evita o limite de tamanho da funcao serverless).
export async function obterGravacao(
  recordingId: string,
): Promise<{ response: Response; ext: string }> {
  // 1) token de acesso a gravacao. O endpoint do GoTo as vezes devolve 5xx
  // (502/503/504) de forma transitoria enquanto o token e gerado do lado deles,
  // entao tentamos algumas vezes com backoff antes de desistir.
  const tokenUrl = `${API_BASE}/recording/v1/recordings/${encodeURIComponent(
    recordingId,
  )}/content`;
  let tokenRes: Response;
  let tokenPayload: unknown;
  const MAX_TENTATIVAS = 4;
  for (let tentativa = 1; ; tentativa += 1) {
    tokenRes = await authedFetch(tokenUrl);
    tokenPayload = await readJson(tokenRes);
    // 5xx = falha transitoria do GoTo -> vale a pena repetir
    if (tokenRes.status >= 500 && tentativa < MAX_TENTATIVAS) {
      const esperaMs = 500 * 2 ** (tentativa - 1); // 500, 1000, 2000ms
      console.warn(
        `[goto] token da gravacao HTTP ${tokenRes.status} (tentativa ${tentativa}/${MAX_TENTATIVAS}); retry em ${esperaMs}ms`,
      );
      await new Promise((r) => setTimeout(r, esperaMs));
      continue;
    }
    break;
  }
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
  return { response: mediaRes, ext };
}

export async function downloadRecording(recordingId: string): Promise<string> {
  const { response, ext } = await obterGravacao(recordingId);
  const buffer = Buffer.from(await response.arrayBuffer());
  // O id entra no nome porque agora baixamos VARIOS trechos em sequencia e
  // dois downloads no mesmo milissegundo colidiriam no mesmo arquivo.
  const filePath = path.join(
    os.tmpdir(),
    `goto-recording-${Date.now()}-${recordingId.replace(/[^\w-]/g, "").slice(0, 16)}${ext}`,
  );
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}
