import fs from "fs";
import path from "path";
import { AppError, getErrorMessage } from "../lib/errors";

// Azure AI Speech — Fast Transcription (sincrono, sem fila/Blob).
// POST multipart do arquivo de audio -> transcript na propria resposta.
// Ativa so quando AZURE_SPEECH_KEY + regiao/endpoint existem (senao fica dormante
// e o fluxo segue no provedor padrao). Ver transcricao.ts para o gate por ramal.

function baseUrl(): string {
  const endpoint = (process.env.AZURE_SPEECH_ENDPOINT || "")
    .trim()
    .replace(/\/+$/, "");
  if (endpoint) return endpoint;
  const region = (process.env.AZURE_SPEECH_REGION || "").trim();
  return region ? `https://${region}.api.cognitive.microsoft.com` : "";
}

export function azureConfigurado(): boolean {
  return !!((process.env.AZURE_SPEECH_KEY || "").trim() && baseUrl());
}

function inferMime(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".wav":
    case ".wave":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".ogg":
    case ".opus":
      return "audio/ogg";
    case ".flac":
      return "audio/flac";
    case ".webm":
      return "audio/webm";
    default:
      return "application/octet-stream";
  }
}

interface FastResponse {
  durationMilliseconds?: number;
  combinedPhrases?: { text?: string }[];
  phrases?: { text?: string }[];
}

// Monta o texto final a partir do texto combinado; se faltar, junta as frases.
function montarTranscript(data: FastResponse): string {
  const cp = Array.isArray(data.combinedPhrases) ? data.combinedPhrases : [];
  const combinado = cp
    .map((c) => String(c?.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (combinado) return combinado;
  const ph = Array.isArray(data.phrases) ? data.phrases : [];
  return ph
    .map((p) => String(p?.text || "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

export async function transcreverAudioAzure(
  audioPath: string,
): Promise<{ transcript: string; durationMs?: number }> {
  const key = (process.env.AZURE_SPEECH_KEY || "").trim();
  const base = baseUrl();
  if (!key || !base) {
    throw new AppError({
      statusCode: 500,
      code: "AZURE_SPEECH_NAO_CONFIGURADO",
      message: "Azure Speech nao configurado (AZURE_SPEECH_KEY / REGION).",
    });
  }

  const apiVersion = (process.env.AZURE_SPEECH_API_VERSION || "2024-11-15").trim();
  const locale = (process.env.AZURE_SPEECH_LOCALE || "pt-BR").trim();

  const definition: Record<string, unknown> = {
    locales: [locale],
    profanityFilterMode: "None",
  };

  const buf = await fs.promises.readFile(audioPath);
  const form = new FormData();
  form.append(
    "audio",
    new Blob([new Uint8Array(buf)], { type: inferMime(audioPath) }),
    path.basename(audioPath),
  );
  form.append("definition", JSON.stringify(definition));

  const url = `${base}/speechtotext/transcriptions:transcribe?api-version=${encodeURIComponent(
    apiVersion,
  )}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": key },
      body: form,
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) {
    throw new AppError({
      statusCode: 502,
      code: "AZURE_SPEECH_UNREACHABLE",
      message: "Nao foi possivel conectar ao Azure Speech.",
      details: { cause: getErrorMessage(error) },
    });
  }

  const corpo = await res.text();
  if (!res.ok) {
    throw new AppError({
      statusCode: res.status === 401 || res.status === 403 ? 401 : 502,
      code: "AZURE_SPEECH_ERROR",
      message: `Falha no Azure Speech (HTTP ${res.status}).`,
      details: { corpo: corpo.slice(0, 500) },
    });
  }

  let data: FastResponse;
  try {
    data = JSON.parse(corpo) as FastResponse;
  } catch {
    data = {};
  }

  return {
    transcript: montarTranscript(data),
    durationMs: Number(data.durationMilliseconds) || undefined,
  };
}
