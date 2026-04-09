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

export async function healthController(_req: Request, res: Response) {
  res.status(200).json({
    ok: true,
    status: "up",
    timestamp: new Date().toISOString(),
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
    audioPath: getOptionalString(body, "audioPath"),
    srtPath: getOptionalString(body, "srtPath"),
    model: getOptionalString(body, "model"),
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
