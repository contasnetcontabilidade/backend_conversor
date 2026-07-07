import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { AppError, getErrorMessage, isRecord } from "../lib/errors";
import { gerarResumoGemini } from "../services/gemini";
import { transcreverAudio } from "../services/transcricao";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
} from "../services/gotoAuth";
import {
  downloadRecording,
  extractRecordingUrl,
  getCallReport,
  setupCallEventsSubscription,
} from "../services/gotoApi";
import {
  CallEndedEvent,
  drainEvents,
  pushEvent,
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

  // Responde imediatamente (GoTo espera 2xx rapido).
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!isRecord(body)) return;

    const type = String(body.type || body.eventType || "").toUpperCase();
    if (type !== "ENDING") return;

    const conversationSpaceId = String(
      body.conversationSpaceId || body.conversationId || "",
    );
    if (!conversationSpaceId) return;

    const { from, to } = extractParties(body);
    const event: CallEndedEvent = {
      id: String(body.id || `${conversationSpaceId}:${body.timestamp || ""}`),
      conversationSpaceId,
      direction: typeof body.direction === "string" ? body.direction : undefined,
      from,
      to,
      endedAt:
        typeof body.timestamp === "string"
          ? body.timestamp
          : new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    };

    await pushEvent(event);
  } catch (err) {
    // Nunca falha o webhook por erro de processamento (ja respondeu 200).
    console.error("[goto] erro ao processar webhook:", getErrorMessage(err));
  }
}

// GET /goto/eventos — o desktop faz polling; drena eventos pendentes.
export async function gotoEventosController(_req: Request, res: Response) {
  const eventos = await drainEvents();
  res.status(200).json({ ok: true, eventos });
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

  const report = await getCallReport(conversationSpaceId);
  const recordingUrl = extractRecordingUrl(report);
  if (!recordingUrl) {
    throw new AppError({
      statusCode: 404,
      code: "RECORDING_NOT_FOUND",
      message:
        "Gravacao ainda nao disponivel para esta chamada. Tente novamente em instantes ou selecione o arquivo manualmente.",
    });
  }

  const audioPath = await downloadRecording(recordingUrl);
  const transcricao = await transcreverAudio({ audioPath });
  const resumo = await gerarResumoGemini({
    srtPath: transcricao.srtPath,
    model: geminiModel,
  });

  res.status(200).json({
    ok: true,
    data: { conversationSpaceId, transcricao, resumo },
  });
}

// ---- helpers ----

function extractParties(body: Record<string, unknown>): {
  from?: string;
  to?: string;
} {
  const participants = body.participants;
  if (!Array.isArray(participants)) return {};
  const numbers: string[] = [];
  for (const p of participants) {
    if (isRecord(p)) {
      const num =
        (typeof p.number === "string" && p.number) ||
        (isRecord(p.callee) && typeof p.callee.number === "string"
          ? p.callee.number
          : "");
      if (num) numbers.push(num);
    }
  }
  return { from: numbers[0], to: numbers[1] };
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
