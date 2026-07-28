﻿import { Request, Response } from "express";
import fs from "fs";
import { AppError } from "../lib/errors";
import { gerarResumoGemini } from "../services/gemini";
import { transcreverAudio } from "../services/transcricao";
import {
  ensureBodyObject,
  getOptionalBoolean,
  getOptionalString,
} from "../utils/request";

// Versao do package.json. Vale tanto em dev (src/controllers -> ../../) quanto
// no build da Vercel (dist/controllers -> ../../). Se falhar, nao quebra nada.
function versaoApp(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return String(require("../../package.json").version || "");
  } catch {
    return "";
  }
}

// GET /health — sonda de vida E identidade do build.
// O `commit` responde "qual codigo esta no ar?" sem precisar abrir o painel da
// Vercel nem caçar marcador no HTML (o webhook de deploy ja falhou 2x).
export async function healthController(_req: Request, res: Response) {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
  res.status(200).json({
    ok: true,
    status: "up",
    timestamp: new Date().toISOString(),
    versao: versaoApp(),
    commit: sha.slice(0, 7),
    commitCompleto: sha,
    branch: process.env.VERCEL_GIT_COMMIT_REF || "",
    mensagemCommit: process.env.VERCEL_GIT_COMMIT_MESSAGE || "",
    ambiente: process.env.VERCEL_ENV || (process.env.VERCEL ? "vercel" : "local"),
    regiao: process.env.VERCEL_REGION || "",
  });
}

export async function transcricaoController(req: Request, res: Response) {
  const body = ensureBodyObject(req.body);

  const result = await transcreverAudio({
    audioPath: getOptionalString(body, "audioPath"),
    modelName: getOptionalString(body, "modelName"),
    autoDownloadModelName: getOptionalString(body, "autoDownloadModelName"),
    withCuda: getOptionalBoolean(body, "withCuda"),
  });

  res.status(200).json({ ok: true, data: result });
}

export async function resumoController(req: Request, res: Response) {
  const body = ensureBodyObject(req.body);

  const result = await gerarResumoGemini({
    text: getOptionalString(body, "text"), // re-resumir a partir do texto ja transcrito
    audioPath: getOptionalString(body, "audioPath"),
    srtPath: getOptionalString(body, "srtPath"),
    model: getOptionalString(body, "model"),
    ramal: getOptionalString(body, "ramal"),
    usuario: getOptionalString(body, "usuario"),
    fonte: getOptionalString(body, "fonte") as
      | "ligacao"
      | "email"
      | "resumo"
      | undefined,
  });

  res.status(200).json({ ok: true, data: result });
}

export async function processarController(req: Request, res: Response) {
  const body = ensureBodyObject(req.body);

  const audioPath = getOptionalString(body, "audioPath");
  const modelName = getOptionalString(body, "modelName");
  const autoDownloadModelName = getOptionalString(
    body,
    "autoDownloadModelName",
  );
  const withCuda = getOptionalBoolean(body, "withCuda");
  const geminiModel = getOptionalString(body, "geminiModel");

  const transcricao = await transcreverAudio({
    audioPath,
    modelName,
    autoDownloadModelName,
    withCuda,
  });

  const resumo = await gerarResumoGemini({
    srtPath: transcricao.srtPath,
    model: geminiModel,
  });

  res.status(200).json({
    ok: true,
    data: {
      transcricao,
      resumo,
    },
  });
}

function parseBooleanLike(value: unknown, defaultValue: boolean) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "sim"].includes(normalized)) {
      return true;
    }

    if (["0", "false", "no", "off", "nao", "não"].includes(normalized)) {
      return false;
    }
  }

  return defaultValue;
}

export async function processarUploadController(req: Request, res: Response) {
  const body = ensureBodyObject(req.body);

  const executarTranscricao = parseBooleanLike(body.executarTranscricao, true);
  const executarResumo = parseBooleanLike(body.executarResumo, true);
  // Identidade de quem gravou/enviou (mandada pelo desktop) e fonte "resumo":
  // separa o custo da pagina "Transcrever & Resumir" e atribui por usuario.
  const ramal = getOptionalString(body, "ramal");
  const usuario = getOptionalString(body, "usuario");

  if (!executarTranscricao && !executarResumo) {
    throw new AppError({
      statusCode: 400,
      code: "NO_ACTION_SELECTED",
      message: "Selecione pelo menos uma acao: transcricao e/ou resumo.",
    });
  }

  let transcricao: Awaited<ReturnType<typeof transcreverAudio>> | undefined;

  if (executarTranscricao) {
    if (!req.file?.path) {
      throw new AppError({
        statusCode: 400,
        code: "AUDIO_FILE_REQUIRED",
        message:
          "Envie um arquivo no campo audioFile para executar transcricao.",
      });
    }

    transcricao = await transcreverAudio({
      audioPath: req.file.path,
      modelName: getOptionalString(body, "modelName"),
      autoDownloadModelName: getOptionalString(body, "autoDownloadModelName"),
      withCuda: parseBooleanLike(body.withCuda, false),
      ramal,
      usuario,
      fonte: "resumo",
    });
  }

  let resumo: Awaited<ReturnType<typeof gerarResumoGemini>> | undefined;

  if (executarResumo) {
    const srtPathFromBody = getOptionalString(body, "srtPath");
    const srtPath = transcricao?.srtPath ?? srtPathFromBody;

    if (!srtPath) {
      throw new AppError({
        statusCode: 400,
        code: "SRT_NOT_PROVIDED",
        message: "Para gerar resumo sem transcricao, informe srtPath no body.",
      });
    }

    resumo = await gerarResumoGemini({
      srtPath,
      model: getOptionalString(body, "geminiModel"),
      ramal,
      usuario,
      fonte: "resumo",
    });
  }

  res.status(200).json({
    ok: true,
    data: {
      executarTranscricao,
      executarResumo,
      arquivoEnviado: req.file
        ? {
            originalName: req.file.originalname,
            savedPath: req.file.path,
            mimeType: req.file.mimetype,
            size: req.file.size,
          }
        : null,
      transcricao: transcricao ?? null,
      resumo: resumo ?? null,
    },
  });
}
