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
import {
  downloadRecording,
  extractRecordingId,
  getCallReport,
  listarHistoricoChamadas,
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
}
export interface AnaliseChamada {
  tipo: "externo" | "interno";
  numeroExterno?: string; // externo
  caller?: ParticipanteLinha; // interno: quem ligou
  answerers: ParticipanteLinha[]; // quem atendeu (LINE com gravacao)
}

function dedupRamal(arr: ParticipanteLinha[]): ParticipanteLinha[] {
  const seen = new Set<string>();
  return arr.filter((a) => (seen.has(a.ramal) ? false : seen.add(a.ramal)));
}

// Analisa o relatorio: externo (com numero do cliente) ou interno (caller + answerers).
export function analisarChamada(
  report: Record<string, unknown>,
): AnaliseChamada | null {
  const participants = report.participants;
  if (!Array.isArray(participants)) return null;
  const direction = String(report.direction || "").toUpperCase();

  // answerers (com gravacao): usado no externo, para saber quem ATENDEU o cliente.
  const answerers: ParticipanteLinha[] = [];
  // todasLinhas: todos os ramais LINE, COM ou SEM gravacao. Usado no interno,
  // onde a chamada normalmente nao e gravada (nao da pra exigir recordings).
  const todasLinhas: ParticipanteLinha[] = [];
  for (const p of participants) {
    if (
      isRecord(p) &&
      isRecord(p.type) &&
      p.type.value === "LINE" &&
      typeof p.type.extensionNumber === "string" &&
      p.type.extensionNumber
    ) {
      const linha = {
        ramal: p.type.extensionNumber,
        nome: typeof p.type.name === "string" ? p.type.name : "",
      };
      todasLinhas.push(linha);
      if (Array.isArray(p.recordings) && p.recordings.length > 0) {
        answerers.push(linha);
      }
    }
  }

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
    return { tipo: "externo", numeroExterno, answerers: dedupRamal(answerers) };
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
      caller = {
        ramal: p.type.extensionNumber,
        nome: typeof p.type.name === "string" ? p.type.name : "",
      };
      break;
    }
  }
  // Interno: quem atendeu = os demais ramais LINE (sem exigir gravacao).
  const answerersInternos = dedupRamal(
    todasLinhas.filter((a) => a.ramal !== caller?.ramal),
  );
  return { tipo: "interno", caller, answerers: answerersInternos };
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
      if (eventEnvolveExterno(body)) {
        const ramais = extractExtensions(body);
        await Promise.all(
          ramais.map((r) => publicarRamal(r, { ...event, tipo: "externo" })),
        );
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
      const ev: CallEndedEvent = {
        ...event,
        tipo: "externo",
        contatoNumero: analise.numeroExterno,
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

  const audioPath = await downloadRecording(recordingId);
  const transcricao = await transcreverAudio({
    audioPath,
    ramal: ramalUsuario,
    usuario: nomeUsuario,
  });
  const resumo = await gerarResumoGemini({
    srtPath: transcricao.srtPath,
    model: geminiModel,
    ramal: ramalUsuario,
    usuario: nomeUsuario,
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
