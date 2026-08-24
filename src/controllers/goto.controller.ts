import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { waitUntil } from "@vercel/functions";
import { AppError, getErrorMessage, isRecord } from "../lib/errors";
import { gerarResumoGemini } from "../services/gemini";
import { transcreverAudio } from "../services/transcricao";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
} from "../services/gotoAuth";
import { Readable } from "node:stream";
import {
  downloadRecording,
  extractRecordingId,
  escolherTrechoPeloRelatorio,
  extractRecordingIds,
  extractRecordings,
  participantesDoRelatorio,
  getCallReport,
  listarHistoricoChamadas,
  obterGravacao,
  setupCallEventsSubscription,
} from "../services/gotoApi";
import {
  createRamalTokenRequest,
  isAblyConfigured,
  publishCallEnded,
} from "../services/ably";
import {
  CallEndedEvent,
  chamadoFoiAberto,
  drainEvents,
  getTrechoPrincipal,
  marcarChamadoAberto,
} from "../services/store";
import { ensureBodyObject, getOptionalString } from "../utils/request";

function publicWebhookUrl(): string {
  const base = process.env.GOTO_PUBLIC_BASE || "https://backend-conversor.vercel.app";
  const token = process.env.GOTO_WEBHOOK_TOKEN || "";
  return `${base.replace(/\/+$/, "")}/api/goto/webhook/${token}`;
}

// GET /goto/oauth/start — redireciona o super-admin para o consentimento GoTo.
export async function gotoOAuthStartController(_req: Request, res: Response) {
  const state = process.env.GOTO_OAUTH_STATE || randomUUID();
  res.redirect(buildAuthorizeUrl(state));
}

// GET /goto/oauth/callback — troca o code por tokens e cria a subscription.
export async function gotoOAuthCallbackController(req: Request, res: Response) {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const error = typeof req.query.error === "string" ? req.query.error : "";

  if (error) {
    res
      .status(400)
      .send(renderPage("Autorizacao negada", `O GoTo retornou: ${error}`));
    return;
  }
  if (!code) {
    res
      .status(400)
      .send(renderPage("Falta o code", "Parametro 'code' ausente no callback."));
    return;
  }

  await exchangeCodeForTokens(code);

  let subscriptionMsg = "";
  try {
    const { channelId } = await setupCallEventsSubscription(publicWebhookUrl());
    subscriptionMsg = `Webhook e subscription criados (channel ${channelId}).`;
  } catch (err) {
    subscriptionMsg =
      "Tokens salvos, mas a subscription falhou: " + getErrorMessage(err);
  }

  res
    .status(200)
    .send(
      renderPage(
        "GoTo conectado com sucesso",
        `Autorizacao concluida. ${subscriptionMsg} Pode fechar esta janela.`,
      ),
    );
}

// POST /goto/setup/:token — cria o canal webhook + subscription (pos-deploy).
// Protegido pelo mesmo token secreto do webhook.
export async function gotoSetupController(req: Request, res: Response) {
  const expected = process.env.GOTO_WEBHOOK_TOKEN;
  if (!expected || req.params.token !== expected) {
    res.sendStatus(404);
    return;
  }

  const result = await setupCallEventsSubscription(publicWebhookUrl());
  res.status(200).json({
    ok: true,
    channelId: result.channelId,
    accountKey: result.accountKey,
    webhookUrl: publicWebhookUrl(),
  });
}

// POST /goto/webhook/:token — recebe eventos do GoTo. Ack rapido + enfileira.
export async function gotoWebhookController(req: Request, res: Response) {
  const expected = process.env.GOTO_WEBHOOK_TOKEN;
  if (!expected || req.params.token !== expected) {
    res.sendStatus(404);
    return;
  }

  const body = req.body;

  // Responde imediatamente. O roteamento roda em SEGUNDO PLANO (waitUntil):
  // o relatorio de ENTRADA nao fica pronto no instante do ENDING, entao
  // esperamos ele sem travar o ack do webhook.
  res.sendStatus(200);

  if (!isRecord(body)) return;
  const content = isRecord(body.content) ? body.content : {};
  const metadata = isRecord(content.metadata) ? content.metadata : {};
  const state = isRecord(content.state) ? content.state : {};

  const type = String(
    state.type || body.type || body.eventType || "",
  ).toUpperCase();
  const conversationSpaceId = String(
    metadata.conversationSpaceId ||
      body.conversationSpaceId ||
      body.conversationId ||
      "",
  );
  if (type !== "ENDING" || !conversationSpaceId) return;

  const timestamp =
    typeof state.timestamp === "string"
      ? state.timestamp
      : typeof body.timestamp === "string"
        ? body.timestamp
        : new Date().toISOString();
  const { from, to } = extractParties(body);
  const event: CallEndedEvent = {
    id: String(state.id || body.id || `${conversationSpaceId}:${timestamp}`),
    conversationSpaceId,
    direction:
      typeof metadata.direction === "string" ? metadata.direction : undefined,
    from,
    to,
    endedAt: timestamp,
    receivedAt: new Date().toISOString(),
  };

  const routing = routeCallEnded(conversationSpaceId, event, body);
  try {
    waitUntil(routing);
  } catch {
    // waitUntil indisponivel neste contexto -> roteamento roda best-effort.
  }
}

export interface ParticipanteLinha {
  ramal: string;
  nome: string;
  temGravacao?: boolean; // atendeu com gravacao (atendente "principal")
  duracaoSeg?: number; // duracao no trecho dele, se o relatorio trouxer
  /**
   * true  = atendeu (ha prova no relatorio)
   * false = NAO atendeu (o telefone tocou e ele nao pegou)
   * null  = o relatorio nao permitiu decidir
   */
  atendeu?: boolean | null;
  /** Em que evidencia a decisao acima se apoiou — vai para o log. */
  atendeuPor?: string;
}
export interface AnaliseChamada {
  tipo: "externo" | "interno";
  numeroExterno?: string; // externo
  caller?: ParticipanteLinha; // interno: quem ligou
  answerers: ParticipanteLinha[]; // TODOS que atenderam (inclui transferidos)
}

// Um mesmo ramal aparece VARIAS vezes no relatorio — uma por dispositivo
// (o app web e o softphone, por exemplo). Numa ligacao real do ramal 252, a
// entrada do `webcalls.integrator` so tocou e a do `goto.clients` atendeu.
// Ficar com a primeira, como antes, dava "nao atendeu" para quem atendeu.
// Agora, entre as entradas do mesmo ramal, vence a que tem a melhor evidencia.
function dedupRamal(arr: ParticipanteLinha[]): ParticipanteLinha[] {
  const porRamal = new Map<string, ParticipanteLinha>();
  const peso = (l: ParticipanteLinha) =>
    (l.atendeu === true ? 4 : l.atendeu === null ? 2 : 0) +
    (l.temGravacao ? 1 : 0);
  for (const l of arr) {
    const atual = porRamal.get(l.ramal);
    if (!atual || peso(l) > peso(atual)) porRamal.set(l.ramal, l);
  }
  // Preserva a ordem de aparicao no relatorio.
  const vistos = new Set<string>();
  const saida: ParticipanteLinha[] = [];
  for (const l of arr) {
    if (vistos.has(l.ramal)) continue;
    vistos.add(l.ramal);
    const escolhido = porRamal.get(l.ramal);
    if (escolhido) saida.push(escolhido);
  }
  return saida;
}

// Duracao (segundos) do participante, best-effort: o relatorio do GoTo e lido
// "cru", entao tentamos varios nomes de campo (duracao direta ou timestamps).
// Se nada bater, devolve undefined (mostramos so nome/ramal).
function tsMs(v: unknown): number | null {
  if (typeof v === "number" && v > 0) return v < 1e12 ? v * 1000 : v; // s -> ms
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}
function duracaoParticipante(p: Record<string, unknown>): number | undefined {
  for (const k of ["durationSeconds", "durationSeg", "talkTime", "duration"]) {
    const v = p[k];
    if (typeof v === "number" && v > 0) return Math.round(v > 1e5 ? v / 1000 : v);
    if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  }
  let ini: number | null = null;
  let fim: number | null = null;
  for (const k of ["startTime", "connectedTime", "answeredTime", "joinedTime", "start"]) {
    ini = tsMs(p[k]);
    if (ini) break;
  }
  for (const k of ["endTime", "disconnectedTime", "leftTime", "end"]) {
    fim = tsMs(p[k]);
    if (fim) break;
  }
  if (ini && fim && fim > ini) return Math.round((fim - ini) / 1000);
  return undefined;
}

// Quem realmente ATENDEU.
//
// Numa fila ou transferencia o telefone toca para varias pessoas, e ate agora
// todas entravam como "atendentes" — inclusive quem so viu o telefone tocar.
//
// A fonte da verdade e `report.callStates`: uma linha do tempo de eventos
// (STARTING / ACTIVE / ENDING) em que cada participante aparece com
// `status.value` = RINGING, CONNECTED ou DISCONNECTING. Quem chegou a
// CONNECTED atendeu; quem so tocou e desligou, nao. Isso foi confirmado num
// relatorio real desta conta.
//
// Os objetos de `report.participants` NAO trazem duracao, hangupCause nem
// horario de atendimento — os unicos campos por participante sao id, originator,
// legId e transcripts. Por isso as heuristicas antigas (duracao/hangup) quase
// sempre caiam em "sem evidencia"; ficam so como reserva, para o caso de a
// conta passar a devolver esses campos.

// Status de callStates que provam atendimento.
const STATUS_ATENDEU = new Set(["CONNECTED", "ACTIVE", "ANSWERED"]);
// Status que aparecem sem que a pessoa tenha atendido.
const STATUS_SO_TOCOU = new Set(["RINGING", "DISCONNECTING", "DISCONNECTED"]);

// Q.850: 16 = desligou normal (atendeu e encerrou); 17 = ocupado;
// 18 = sem resposta do usuario; 19 = tocou e ninguem atendeu; 21 = rejeitada.
const HANGUP_NAO_ATENDEU = new Set([17, 18, 19, 21]);

function decidirAtendeu(
  p: Record<string, unknown>,
  temGravacao: boolean,
  duracaoSeg: number | undefined,
  status?: Set<string>,
): { atendeu: boolean | null; por: string } {
  // 0) callStates: o dado explicito da conta. Vem antes de tudo.
  if (status && status.size) {
    for (const st of status) {
      if (STATUS_ATENDEU.has(st)) return { atendeu: true, por: `status ${st}` };
    }
    // Teve status, mas nenhum de atendimento: tocou e nao pegou.
    const soTocou = [...status].every((st) => STATUS_SO_TOCOU.has(st));
    if (soTocou) {
      return { atendeu: false, por: `so ${[...status].join("/")}` };
    }
  }

  // 1) Gravacao: quase tao forte quanto. Um trecho gravado significa audio.
  if (temGravacao) return { atendeu: true, por: "tem gravacao" };

  // 2) Campo booleano explicito, se existir.
  for (const k of ["answered", "wasAnswered", "connected", "isAnswered"]) {
    const v = p[k];
    if (v === true) return { atendeu: true, por: `${k}=true` };
    if (v === false) return { atendeu: false, por: `${k}=false` };
  }

  // 3) Horario de atendimento preenchido = atendeu.
  for (const k of ["answeredTime", "connectedTime", "answerTime", "talkStartTime"]) {
    if (tsMs(p[k])) return { atendeu: true, por: `${k} preenchido` };
  }

  // 4) Tempo de conversa > 0 = atendeu.
  if (typeof duracaoSeg === "number" && duracaoSeg > 0) {
    return { atendeu: true, por: `duracao ${duracaoSeg}s` };
  }

  // 5) Causa de desligamento que significa "nao atendeu".
  const causa = p.hangupCause ?? p.disconnectCause ?? p.cause;
  const causaNum = typeof causa === "number" ? causa : Number(causa);
  if (Number.isFinite(causaNum)) {
    if (HANGUP_NAO_ATENDEU.has(causaNum)) {
      return { atendeu: false, por: `hangupCause=${causaNum}` };
    }
    if (causaNum === 16) return { atendeu: true, por: "hangupCause=16" };
  }

  // 6) Duracao informada como ZERO (nao ausente) = tocou e nao atenderam.
  //
  // Le os campos CRUS, e nao o `duracaoSeg` do parametro: duracaoParticipante()
  // so devolve valores > 0, entao um `duration: 0` chega aqui como `undefined` e
  // seria confundido com "o relatorio nao informou". Sao coisas diferentes —
  // "zero segundos de conversa" e justamente a prova de que nao atendeu.
  for (const k of ["durationSeconds", "durationSeg", "talkTime", "duration"]) {
    const v = p[k];
    if (v === 0 || v === "0") return { atendeu: false, por: `${k}=0` };
  }

  return { atendeu: null, por: "sem evidencia" };
}

// Aplica o filtro com uma trava de seguranca: se NINGUEM ficar de pe, devolve a
// lista original. Chamado sem atendente nenhum e pior que um atendente a mais —
// e seria o resultado sempre que o relatorio nao trouxesse esses campos.
function somenteQuemAtendeu(linhas: ParticipanteLinha[]): ParticipanteLinha[] {
  const ficam = linhas.filter((l) => l.atendeu !== false);
  return ficam.length ? ficam : linhas;
}

// Analisa o relatorio: externo (com numero do cliente) ou interno (caller + answerers).// Analisa o relatorio: externo (com numero do cliente) ou interno (caller + answerers).
export function analisarChamada(
  report: Record<string, unknown>,
): AnaliseChamada | null {
  const participants = report.participants;
  if (!Array.isArray(participants)) return null;
  const direction = String(report.direction || "").toUpperCase();

  // todasLinhas: TODOS os ramais LINE (com ou sem gravacao) na ordem do relatorio.
  // Numa transferencia, o atendente transferido pode nao ter gravacao no trecho
  // dele — por isso NAO exigimos recordings para captura-lo.
  // participantesDoRelatorio une `participants` com quem so aparece em
  // `callStates`. Numa fila real com transferencia, 2 dos 3 atendentes (com
  // gravacao) estavam FORA de `participants` — inclusive a pessoa que atendeu
  // primeiro e transferiu. Iterar so a lista declarada perdia esses atendentes.
  const todasLinhas: ParticipanteLinha[] = participantesDoRelatorio(report).map(
    (p) => {
      const dur = duracaoParticipante(p.bruto);
      const temGravacao = p.recordings.length > 0;
      const decisao = decidirAtendeu(p.bruto, temGravacao, dur, p.status);
      if (process.env.GOTO_LOG_PARTICIPANTES === "1") {
        console.log("[goto][participante]", JSON.stringify(p.bruto));
      }
      return {
        ramal: p.ramal,
        nome: p.nome,
        temGravacao,
        ...(dur != null ? { duracaoSeg: dur } : {}),
        atendeu: decisao.atendeu,
        atendeuPor: decisao.por,
      };
    },
  );

  const externo = participants.find(
    (p) => isRecord(p) && isRecord(p.type) && p.type.value === "PHONE_NUMBER",
  );
  if (externo && isRecord(externo) && isRecord(externo.type)) {
    const t = externo.type as Record<string, unknown>;
    const callerObj = isRecord(t.caller)
      ? (t.caller as Record<string, unknown>)
      : {};
    const numeroExterno =
      direction === "INBOUND"
        ? String(callerObj.number || t.number || "")
        : String(t.number || callerObj.number || "");
    // Externo: TODOS os ramais LINE sao atendentes (inclui os transferidos).
    return {
      tipo: "externo",
      numeroExterno,
      answerers: somenteQuemAtendeu(dedupRamal(todasLinhas)),
    };
  }

  // Interno: caller = participante LINE onde id === originator (quem iniciou).
  let caller: ParticipanteLinha | undefined;
  for (const p of participants) {
    if (
      isRecord(p) &&
      isRecord(p.type) &&
      p.type.value === "LINE" &&
      typeof p.type.extensionNumber === "string" &&
      p.id === p.originator
    ) {
      // Reaproveita a linha JA analisada (com atendeu/atendeuPor). Montar um
      // objeto novo aqui, como antes, fazia quem ligou aparecer sempre como
      // "sem evidencia" no log — mesmo tendo CONNECTED em callStates.
      const ramalCaller = p.type.extensionNumber;
      caller = todasLinhas.find((l) => l.ramal === ramalCaller) || {
        ramal: ramalCaller,
        nome: typeof p.type.name === "string" ? p.type.name : "",
      };
      break;
    }
  }
  // Interno: quem atendeu = os demais ramais LINE (sem exigir gravacao).
  const answerersInternos = somenteQuemAtendeu(
    dedupRamal(todasLinhas.filter((a) => a.ramal !== caller?.ramal)),
  );
  return { tipo: "interno", caller, answerers: answerersInternos };
}

// Nome ("NOME - SETOR") do participante LINE com o ramal informado, buscado
// diretamente no relatorio. Usado para atribuir o chamado a QUEM CLICOU em
// "abrir chamado" (o desktop manda o proprio ramal). Retorna:
//  - a string do nome (pode ser "") se o ramal participou da ligacao;
//  - null se esse ramal nao aparece no relatorio (clicador nao esteve na chamada).
export function nomeDoRamal(
  report: Record<string, unknown>,
  ramal: string | undefined,
): string | null {
  const alvo = String(ramal || "").trim();
  if (!alvo) return null;
  const participants = report.participants;
  if (!Array.isArray(participants)) return null;
  for (const p of participants) {
    if (
      isRecord(p) &&
      isRecord(p.type) &&
      p.type.value === "LINE" &&
      String(p.type.extensionNumber || "") === alvo
    ) {
      return typeof p.type.name === "string" ? p.type.name : "";
    }
  }
  return null;
}

async function publicarRamal(ramal: string, ev: CallEndedEvent): Promise<void> {
  await publishCallEnded(ramal, ev).catch((e) =>
    console.error(`[goto] falha ao publicar ramal ${ramal}:`, getErrorMessage(e)),
  );
}

// Roteia o popup em segundo plano (waitUntil): espera o relatorio ficar pronto.
//  - Externa: notifica quem ATENDEU, com o numero do cliente.
//  - Interna: escalonamento -> quem LIGOU primeiro; se nao abrir chamado em
//    ~25s, notifica quem ATENDEU. Ambos veem o ramal+nome do outro participante.
async function routeCallEnded(
  conversationSpaceId: string,
  event: CallEndedEvent,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    const report = await getReportComRetry(conversationSpaceId);
    if (!isAblyConfigured()) return;

    if (!report) {
      // Fallback (relatorio nunca ficou pronto): usa o evento (cobre saida externa).
      // Numero do cliente = o discado (dialString = event.to).
      if (eventEnvolveExterno(body)) {
        const ramais = extractExtensions(body);
        const ev: CallEndedEvent = {
          ...event,
          tipo: "externo",
          ...(event.to ? { contatoNumero: event.to } : {}),
        };
        await Promise.all(ramais.map((r) => publicarRamal(r, ev)));
      }
      return;
    }

    const analise = analisarChamada(report);
    if (!analise) {
      console.log(`[goto:route] conv=${conversationSpaceId} analise=null (sem participantes?)`);
      return;
    }
    console.log(
      `[goto:route] conv=${conversationSpaceId} tipo=${analise.tipo} ` +
        `caller=${analise.caller?.ramal || "-"} ` +
        `answerers=[${analise.answerers.map((a) => a.ramal).join(",")}] ` +
        `numeroExterno=${analise.numeroExterno || "-"}`,
    );

    if (analise.tipo === "externo") {
      // Numero do CLIENTE:
      //  - SAIDA (OUTBOUND): e o numero DISCADO (dialString = event.to). O relatorio
      //    as vezes traz o proprio numero do escritorio no participante externo.
      //  - ENTRADA (INBOUND): segue o numero do relatorio (caller = quem ligou).
      const dir = String(
        event.direction || (report as Record<string, unknown>).direction || "",
      ).toUpperCase();
      const numeroCliente =
        dir.includes("OUT") && event.to ? event.to : analise.numeroExterno;
      console.log(
        `[goto:externo] conv=${conversationSpaceId} dir=${event.direction || "-"} ` +
          `dialString=${event.to || "-"} numExtReport=${analise.numeroExterno || "-"} => ${numeroCliente || "-"}`,
      );
      const ev: CallEndedEvent = {
        ...event,
        tipo: "externo",
        contatoNumero: numeroCliente,
      };
      await Promise.all(analise.answerers.map((a) => publicarRamal(a.ramal, ev)));
      return;
    }

    // Interno: escalonamento.
    const { caller, answerers } = analise;
    if (answerers.length === 0) return; // ninguem atendeu -> nada a fazer

    if (!caller) {
      // sem caller identificavel -> notifica os answerers direto.
      await Promise.all(
        answerers.map((a) => publicarRamal(a.ramal, { ...event, tipo: "interno" })),
      );
      return;
    }

    // 1) popup pro caller, mostrando o outro participante (quem ele ligou).
    const outro = answerers[0];
    await publicarRamal(caller.ramal, {
      ...event,
      tipo: "interno",
      contatoRamal: outro.ramal,
      contatoNome: outro.nome,
    });

    // 2) espera ~25s; se o chamado nao foi aberto, escala pros answerers.
    await new Promise((r) => setTimeout(r, 25000));
    if (!(await chamadoFoiAberto(conversationSpaceId))) {
      await Promise.all(
        answerers.map((a) =>
          publicarRamal(a.ramal, {
            ...event,
            tipo: "interno",
            contatoRamal: caller.ramal,
            contatoNome: caller.nome,
          }),
        ),
      );
    }
  } catch (err) {
    console.error(
      "[goto] erro no roteamento da chamada:",
      getErrorMessage(err),
    );
  }
}

// GET /goto/ably-token?ramal=XXX — token temporario para o app assinar seu ramal.
export async function gotoAblyTokenController(req: Request, res: Response) {
  const ramal =
    typeof req.query.ramal === "string" ? req.query.ramal.trim() : "";
  if (!ramal) {
    throw new AppError({
      statusCode: 400,
      code: "RAMAL_REQUIRED",
      message: "Informe o parametro 'ramal'.",
    });
  }
  const tokenRequest = await createRamalTokenRequest(ramal);
  res.status(200).json(tokenRequest);
}

// GET /goto/eventos — o desktop faz polling; drena eventos pendentes.
export async function gotoEventosController(_req: Request, res: Response) {
  const eventos = await drainEvents();
  res.status(200).json({ ok: true, eventos });
}

// GET /goto/historico?ramal=XXX&limit=N — ultimas chamadas do ramal (call-history).
export async function gotoHistoricoController(req: Request, res: Response) {
  const ramal = typeof req.query.ramal === "string" ? req.query.ramal.trim() : "";
  const limit = Number(req.query.limit) || 15;
  const itens = await listarHistoricoChamadas(ramal, limit);
  res.status(200).json({ ok: true, data: { itens } });
}

// POST /goto/chamado — baixa a gravacao da chamada e gera transcricao + resumo.
// GET /goto/gravacao?conversationSpaceId=X&i=0 — baixa a gravacao da ligacao e a
// envia (stream) para o app salvar. Protegida pelo x-app-token normal do app.
// Numa ligacao com varios trechos, ?i seleciona o trecho; X-Recording-Count no
// header diz quantos existem (o app pode baixar cada um).
export async function gotoGravacaoController(req: Request, res: Response) {
  const conversationSpaceId =
    typeof req.query.conversationSpaceId === "string"
      ? req.query.conversationSpaceId.trim()
      : "";
  if (!conversationSpaceId) {
    throw new AppError({
      statusCode: 400,
      code: "CONVERSATION_ID_REQUIRED",
      message: "Informe conversationSpaceId.",
    });
  }
  // `i=principal` pede o trecho que foi transcrito, sem o app precisar saber o
  // indice de antemao. Um numero pede aquele trecho especifico — e o que o
  // download em lote usa para percorrer 0..N-1.
  const pedido = String(req.query.i ?? "0").trim();
  const querPrincipal = pedido === "principal";
  const i = querPrincipal ? 0 : Math.max(0, parseInt(pedido, 10) || 0);

  const report = await getCallReport(conversationSpaceId);
  const trechos = extractRecordings(report);
  const recordingIds = trechos.map((t) => t.id);
  if (!recordingIds.length) {
    throw new AppError({
      statusCode: 404,
      code: "RECORDING_NOT_FOUND",
      message: "Nenhuma gravacao encontrada para esta ligacao.",
    });
  }

  // Qual e o principal: primeiro o que o preview ja decidiu (pode ter sido pela
  // medicao dos arquivos, que nao da para refazer aqui sem baixar tudo);
  // senao o que o relatorio disser; senao o primeiro.
  const salvo = await getTrechoPrincipal(conversationSpaceId).catch(() => null);
  const doRelatorio = escolherTrechoPeloRelatorio(trechos);
  const principal = Math.min(
    salvo ?? doRelatorio?.indice ?? 0,
    recordingIds.length - 1,
  );

  const idx = querPrincipal ? principal : Math.min(i, recordingIds.length - 1);
  const { response, ext } = await obterGravacao(recordingIds[idx]);

  const nome = `ligacao_${conversationSpaceId.slice(0, 8)}${
    recordingIds.length > 1 ? `_trecho${idx + 1}` : ""
  }${ext}`;
  res.setHeader("Content-Type", ext === ".wav" ? "audio/wav" : "audio/mpeg");
  res.setHeader("Content-Disposition", `attachment; filename="${nome}"`);
  res.setHeader("X-Recording-Count", String(recordingIds.length));
  // Qual trecho e o principal e qual esta sendo servido — o app usa para marcar
  // "principal" na lista de trechos do player.
  res.setHeader("X-Recording-Main", String(principal));
  res.setHeader("X-Recording-Index", String(idx));
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-Recording-Count, X-Recording-Main, X-Recording-Index",
  );
  const len = response.headers.get("content-length");
  if (len) res.setHeader("Content-Length", len);

  if (response.body) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Readable.fromWeb(response.body as any).pipe(res);
  } else {
    res.end(Buffer.from(await response.arrayBuffer()));
  }
}

export async function gotoChamadoController(req: Request, res: Response) {
  const body = ensureBodyObject(req.body);
  const conversationSpaceId = getOptionalString(body, "conversationSpaceId");
  if (!conversationSpaceId) {
    throw new AppError({
      statusCode: 400,
      code: "CONVERSATION_ID_REQUIRED",
      message: "Informe conversationSpaceId no corpo da requisicao.",
    });
  }

  const geminiModel = getOptionalString(body, "geminiModel");

  // Marca cedo que o chamado foi aberto (antes da transcricao longa), para o
  // escalonamento interno nao notificar o answerer se o caller ja abriu.
  await marcarChamadoAberto(conversationSpaceId).catch(() => undefined);

  const report = await getCallReport(conversationSpaceId);
  const recordingId = extractRecordingId(report);
  if (!recordingId) {
    throw new AppError({
      statusCode: 404,
      code: "RECORDING_NOT_FOUND",
      message:
        "Gravacao ainda nao disponivel para esta chamada. Tente novamente em instantes ou selecione o arquivo manualmente.",
    });
  }

  // Identidade da ligacao (usuario do escritorio) para atribuir o custo da IA:
  // interna -> quem ligou; externa -> quem atendeu.
  const analise = analisarChamada(report);
  const usuarioEscritorio =
    analise?.tipo === "interno" ? analise?.caller : analise?.answerers?.[0];
  const ramalUsuario = usuarioEscritorio?.ramal || "";
  const nomeUsuario = usuarioEscritorio?.nome || "";
  // Nomes dos funcionarios desta ligacao (sem " - SETOR") como dica de grafia.
  const nomesConhecidos = Array.from(
    new Set(
      [analise?.caller, ...(analise?.answerers || [])]
        .map((p) => {
          const nome = p?.nome || "";
          const i = nome.lastIndexOf(" - ");
          return (i >= 0 ? nome.slice(0, i) : nome).trim();
        })
        .filter((n) => n.length >= 2),
    ),
  );

  const audioPath = await downloadRecording(recordingId);
  const transcricao = await transcreverAudio({
    audioPath,
    ramal: ramalUsuario,
    usuario: nomeUsuario,
    nomesConhecidos,
    fonte: "ligacao",
  });
  const resumo = await gerarResumoGemini({
    srtPath: transcricao.srtPath,
    model: geminiModel,
    ramal: ramalUsuario,
    usuario: nomeUsuario,
    fonte: "ligacao",
  });

  res.status(200).json({
    ok: true,
    data: { conversationSpaceId, transcricao, resumo },
  });
}

// ---- helpers ----

// Busca o relatorio completo, esperando ele ficar pronto (roda em segundo
// plano, entao pode ser paciente: ~30 tentativas x 3s = ate ~90s).
export async function getReportComRetry(
  conversationSpaceId: string,
): Promise<Record<string, unknown> | null> {
  for (let tentativa = 0; tentativa < 30; tentativa++) {
    try {
      return await getCallReport(conversationSpaceId);
    } catch (error) {
      const notReady =
        error instanceof AppError && error.code === "REPORT_NOT_READY";
      if (notReady && tentativa < 29) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      return null;
    }
  }
  return null;
}

// Verdadeiro se algum participante do EVENTO e numero externo (PHONE_NUMBER).
function eventEnvolveExterno(body: Record<string, unknown>): boolean {
  const content = isRecord(body.content) ? body.content : {};
  const state = isRecord(content.state) ? content.state : {};
  const participants = state.participants;
  if (!Array.isArray(participants)) return false;
  return participants.some(
    (p) => isRecord(p) && isRecord(p.type) && p.type.value === "PHONE_NUMBER",
  );
}

// Extrai os ramais da ligacao. Faz busca profunda por qualquer campo
// "extensionNumber" no payload, para ser resiliente a variacoes de formato.
function extractExtensions(body: Record<string, unknown>): string[] {
  const exts = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (isRecord(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (
          /^extensionNumber$/i.test(key) &&
          (typeof value === "string" || typeof value === "number") &&
          String(value).trim()
        ) {
          exts.add(String(value).trim());
        } else {
          visit(value);
        }
      }
    }
  };
  visit(body);
  return Array.from(exts);
}

function extractParties(body: Record<string, unknown>): {
  from?: string;
  to?: string;
} {
  const content = isRecord(body.content) ? body.content : {};
  const metadata = isRecord(content.metadata) ? content.metadata : {};

  // Numero discado (formato real do GoTo).
  const to =
    typeof metadata.dialString === "string" ? metadata.dialString : undefined;

  // Nome/ramal do participante interno (busca profunda por "name").
  let from: string | undefined;
  const visit = (node: unknown): void => {
    if (from || !node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (isRecord(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (/^name$/i.test(key) && typeof value === "string" && value.trim()) {
          from = value.trim();
          return;
        }
        visit(value);
      }
    }
  };
  visit(body);

  return { from, to };
}

function renderPage(title: string, message: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#0f2135;color:#eef4fb;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#14212f;border:1px solid #24374b;border-radius:16px;padding:32px 36px;
max-width:460px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.5)}
h1{font-size:1.3rem;margin:0 0 10px;color:#3f8fe0}p{color:#d3e0ee;line-height:1.6;margin:0}</style>
</head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}
