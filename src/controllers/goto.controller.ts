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
  extractRecordingId,
  getCallReport,
  setupCallEventsSubscription,
} from "../services/gotoApi";
import {
  createRamalTokenRequest,
  isAblyConfigured,
  publishCallEnded,
  publishDebug,
} from "../services/ably";
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

  // IMPORTANTE: no Vercel (serverless) a funcao congela apos responder, entao
  // fazemos o processamento (publicar no Ably) ANTES de enviar o 2xx. O publish
  // e rapido (~100ms), bem dentro do tempo que o GoTo espera pelo ack.
  try {
    const body = req.body;
    // Debug temporario: espelha o payload cru para inspecao do formato real.
    await publishDebug(body).catch(() => undefined);
    if (isRecord(body)) {
      // Formato real do GoTo: dados aninhados em content.{metadata,state}.
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

      if (type === "ENDING" && conversationSpaceId) {
        const { from, to } = extractParties(body);
        const timestamp =
          typeof state.timestamp === "string"
            ? state.timestamp
            : typeof body.timestamp === "string"
              ? body.timestamp
              : new Date().toISOString();
        const event: CallEndedEvent = {
          id: String(state.id || body.id || `${conversationSpaceId}:${timestamp}`),
          conversationSpaceId,
          direction:
            typeof metadata.direction === "string"
              ? metadata.direction
              : undefined,
          from,
          to,
          endedAt: timestamp,
          receivedAt: new Date().toISOString(),
        };

        // Roteia o evento para o(s) ramal(is) da ligacao via Ably (push).
        const ramais = extractExtensions(body);
        if (isAblyConfigured() && ramais.length > 0) {
          await Promise.all(
            ramais.map((ramal) =>
              publishCallEnded(ramal, event).catch((e) =>
                console.error(
                  `[goto] falha ao publicar ramal ${ramal}:`,
                  getErrorMessage(e),
                ),
              ),
            ),
          );
        } else {
          // Fallback (sem Ably ou sem ramal): fila global.
          await pushEvent(event);
        }
      }
    }
  } catch (err) {
    console.error("[goto] erro ao processar webhook:", getErrorMessage(err));
  }

  res.sendStatus(200);
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
  const recordingId = extractRecordingId(report);
  if (!recordingId) {
    throw new AppError({
      statusCode: 404,
      code: "RECORDING_NOT_FOUND",
      message:
        "Gravacao ainda nao disponivel para esta chamada. Tente novamente em instantes ou selecione o arquivo manualmente.",
    });
  }

  const audioPath = await downloadRecording(recordingId);
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
