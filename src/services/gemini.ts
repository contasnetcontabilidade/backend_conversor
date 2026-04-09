import fs from "fs";
import { readFile } from "fs/promises";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { AppError, getErrorMessage, isRecord } from "../lib/errors";
import { resolveFromProjectRoot } from "../utils/paths";

const DEFAULT_AUDIO_FILE = process.env.DEFAULT_AUDIO_FILE ?? "audio_reuniao.WAV";
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";

let geminiClient: GoogleGenAI | null = null;

export type ResumoJson = {
  titulo: string;
  resumo: string;
  assuntos_abordados: string[];
  pendencias_acoes_necessarias: string[];
};

export type ResumoInput = {
  audioPath?: string;
  srtPath?: string;
  model?: string;
};

function getGeminiClient() {
  // Reutiliza um único client por processo.
  if (geminiClient) {
    return geminiClient;
  }

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new AppError({
      statusCode: 500,
      code: "GEMINI_API_KEY_MISSING",
      message: "GEMINI_API_KEY nao definida no ambiente.",
    });
  }

  geminiClient = new GoogleGenAI({ apiKey });
  return geminiClient;
}

function resolveSrtPath(input: ResumoInput): string {
  if (input.srtPath?.trim()) {
    const explicitPath = input.srtPath.trim();
    return path.isAbsolute(explicitPath)
      ? explicitPath
      : resolveFromProjectRoot(explicitPath);
  }

  const candidateAudio = input.audioPath?.trim() || DEFAULT_AUDIO_FILE;
  const audioPath = path.isAbsolute(candidateAudio)
    ? candidateAudio
    : resolveFromProjectRoot(candidateAudio);

  return `${audioPath}.srt`;
}

function parseResumoJson(rawText: string): ResumoJson {
  // Alguns modelos podem devolver JSON em bloco markdown.
  // Aqui removemos o bloco para fazer parse limpo.
  const normalized = rawText.trim();
  const jsonText = normalized.startsWith("```")
    ? normalized.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : normalized;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new AppError({
      statusCode: 502,
      code: "GEMINI_INVALID_JSON",
      message: "Gemini retornou JSON invalido.",
      details: { cause: getErrorMessage(error), raw: rawText.slice(0, 500) },
    });
  }

  if (!isRecord(parsed)) {
    throw new AppError({
      statusCode: 502,
      code: "GEMINI_INVALID_PAYLOAD",
      message: "Gemini retornou payload inesperado.",
      details: { raw: rawText.slice(0, 500) },
    });
  }

  const titulo = String(parsed.titulo ?? "").trim();
  const resumo = String(parsed.resumo ?? "").trim();
  const assuntos = Array.isArray(parsed.assuntos_abordados)
    ? parsed.assuntos_abordados.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const pendencias = Array.isArray(parsed.pendencias_acoes_necessarias)
    ? parsed.pendencias_acoes_necessarias
        .map((item) => String(item).trim())
        .filter(Boolean)
    : [];

  if (!titulo || !resumo) {
    throw new AppError({
      statusCode: 502,
      code: "GEMINI_MISSING_FIELDS",
      message: "Gemini retornou JSON sem campos obrigatorios.",
      details: { raw: rawText.slice(0, 500) },
    });
  }

  return {
    titulo,
    resumo,
    assuntos_abordados: assuntos,
    pendencias_acoes_necessarias: pendencias,
  };
}

function normalizeGeminiError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (isRecord(error) && typeof error.status === "number") {
    const status = error.status;
    if (status === 429) {
      return new AppError({
        statusCode: 429,
        code: "GEMINI_QUOTA_EXCEEDED",
        message: "Limite/quota da Gemini API excedido.",
        details: { cause: getErrorMessage(error) },
      });
    }

    if (status >= 400 && status < 500) {
      return new AppError({
        statusCode: 502,
        code: "GEMINI_CLIENT_ERROR",
        message: "Gemini retornou erro de requisicao.",
        details: { cause: getErrorMessage(error), upstreamStatus: status },
      });
    }

    if (status >= 500) {
      return new AppError({
        statusCode: 502,
        code: "GEMINI_UPSTREAM_ERROR",
        message: "Gemini indisponivel no momento.",
        details: { cause: getErrorMessage(error), upstreamStatus: status },
      });
    }
  }

  const message = getErrorMessage(error);

  if (/resource_exhausted|quota/i.test(message)) {
    return new AppError({
      statusCode: 429,
      code: "GEMINI_QUOTA_EXCEEDED",
      message: "Limite/quota da Gemini API excedido.",
      details: { cause: message },
    });
  }

  if (/api key should be set|missing api key|default credentials|adc/i.test(message)) {
    return new AppError({
      statusCode: 500,
      code: "GEMINI_AUTH_CONFIG_ERROR",
      message: "Configuracao de autenticacao da Gemini API invalida.",
      details: { cause: message },
    });
  }

  return new AppError({
    statusCode: 502,
    code: "GEMINI_REQUEST_FAILED",
    message: "Falha ao gerar resumo com Gemini.",
    details: { cause: message },
  });
}

export async function gerarResumoGemini(input: ResumoInput = {}): Promise<{
  srtPath: string;
  resumo: ResumoJson;
}> {
  // 1) Descobre o arquivo .srt de origem.
  const srtPath = resolveSrtPath(input);

  if (!fs.existsSync(srtPath)) {
    throw new AppError({
      statusCode: 404,
      code: "SRT_NOT_FOUND",
      message: `Arquivo .srt nao encontrado: ${srtPath}`,
    });
  }

  // 2) Lê transcrição e envia instruções para o Gemini responder em JSON.
  const transcricao = await readFile(srtPath, "utf-8");

  const prompt = `Voce e um especialista em analise textual e sintese estruturada de transcricoes de audio.
Retorne APENAS JSON valido, sem markdown e sem texto fora do JSON.
Campos obrigatorios:
- titulo: string (titulo do resumo)
- resumo: string (resumo executivo)
- assuntos_abordados: string[] (topicos dos assuntos)
- pendencias_acoes_necessarias: string[] (acoes pendentes)
Se nao houver pendencias, retorne array vazio em pendencias_acoes_necessarias.
Nao invente informacoes.`;

  try {
    const response = await getGeminiClient().models.generateContent({
      model: input.model?.trim() || DEFAULT_GEMINI_MODEL,
      contents: `${prompt}\n\nTRANSCRICAO:\n${transcricao}`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          additionalProperties: false,
          required: [
            "titulo",
            "resumo",
            "assuntos_abordados",
            "pendencias_acoes_necessarias",
          ],
          properties: {
            titulo: { type: "string" },
            resumo: { type: "string" },
            assuntos_abordados: {
              type: "array",
              items: { type: "string" },
            },
            pendencias_acoes_necessarias: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
    });

    const rawText = response.text ?? "";
    if (!rawText.trim()) {
      throw new AppError({
        statusCode: 502,
        code: "GEMINI_EMPTY_RESPONSE",
        message: "Gemini nao retornou conteudo no resumo.",
      });
    }

    // 3) Valida e normaliza o JSON recebido.
    return {
      srtPath,
      resumo: parseResumoJson(rawText),
    };
  } catch (error) {
    throw normalizeGeminiError(error);
  }
}
