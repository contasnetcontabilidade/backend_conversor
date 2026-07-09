import fs from "fs";
import { readFile } from "fs/promises";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { AppError, getErrorMessage, isRecord } from "../lib/errors";
import { resolveFromProjectRoot } from "../utils/paths";
import { recordUsage } from "./usage";
import { thinkingConfigFor } from "./geminiThinking";

const DEFAULT_AUDIO_FILE = process.env.DEFAULT_AUDIO_FILE ?? "audio_reuniao.WAV";
// gemini-2.5-flash: mais barato que o 3-flash e permite desligar o thinking
// (thinkingBudget 0). Sobrescrivel por GEMINI_MODEL no ambiente.
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

let geminiClient: GoogleGenAI | null = null;

export type ResumoJson = {
  titulo: string;
  resumo: string;
  pontos_principais: string[];
  providencias_sugeridas: string[];
  cliente_mencionado: { nome: string; cnpj: string };
  // Classificacao para o chamado (o usuario confirma/edita na revisao):
  setor_sugerido: string; // um dos setores da lista fornecida, ou "" se incerto
  assunto_sugerido: string; // frase curta do assunto/tipo do chamado
};

export type ResumoInput = {
  audioPath?: string;
  srtPath?: string;
  model?: string;
  setoresDisponiveis?: string[]; // nomes dos setores cadastrados p/ classificacao
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
  const pontos = Array.isArray(parsed.pontos_principais)
    ? parsed.pontos_principais.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const providencias = Array.isArray(parsed.providencias_sugeridas)
    ? parsed.providencias_sugeridas
        .map((item) => String(item).trim())
        .filter(Boolean)
    : [];
  const clienteRaw = isRecord(parsed.cliente_mencionado)
    ? parsed.cliente_mencionado
    : {};
  const clienteMencionado = {
    nome: String(clienteRaw.nome ?? "").trim(),
    cnpj: String(clienteRaw.cnpj ?? "").trim(),
  };
  const setorSugerido = String(parsed.setor_sugerido ?? "").trim();
  const assuntoSugerido = String(parsed.assunto_sugerido ?? "").trim();

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
    pontos_principais: pontos,
    providencias_sugeridas: providencias,
    cliente_mencionado: clienteMencionado,
    setor_sugerido: setorSugerido,
    assunto_sugerido: assuntoSugerido,
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

  const setores = Array.isArray(input.setoresDisponiveis)
    ? input.setoresDisponiveis.filter(Boolean)
    : [];
  const blocoSetor = setores.length
    ? `- setor_sugerido: string. Classifique a demanda em UM destes setores (use EXATAMENTE o nome):
  ${setores.join(" | ")}. Se nenhum encaixar com clareza, use "".`
    : `- setor_sugerido: string (setor responsavel pela demanda, ou "" se incerto).`;

  const prompt = `Voce registra chamados de atendimento telefonico de um escritorio de contabilidade,
a partir da transcricao de uma ligacao. Escreva em portugues do Brasil, tom profissional,
claro e objetivo. Retorne APENAS JSON valido, sem markdown e sem texto fora do JSON.
Campos obrigatorios:
- titulo: string (assunto curto do chamado, ate ~80 caracteres)
- resumo: string (resumo executivo do atendimento, 2 a 5 frases: o que o cliente pediu/relatou e o desfecho)
- pontos_principais: string[] (os principais topicos/fatos tratados na ligacao, curtos e objetivos)
- providencias_sugeridas: string[] (acoes/pendencias a executar apos a ligacao; array vazio se nao houver)
- cliente_mencionado: objeto { nome: string, cnpj: string } com o nome/razao social e o CNPJ do
  cliente SE forem ditos na ligacao; use string vazia "" quando nao mencionado.
${blocoSetor}
- assunto_sugerido: string (o tipo/assunto do chamado em poucas palavras, ex.: "Guia do Simples",
  "Folha de pagamento", "Abertura de empresa"; "" se incerto).
Nao invente informacoes. Se algo nao aparece na transcricao, deixe vazio.`;

  const modelUsado = input.model?.trim() || DEFAULT_GEMINI_MODEL;

  try {
    const response = await getGeminiClient().models.generateContent({
      model: modelUsado,
      contents: `${prompt}\n\nTRANSCRICAO:\n${transcricao}`,
      config: {
        // Desliga/minimiza o thinking para baratear (resumo e JSON estruturado).
        thinkingConfig: thinkingConfigFor(modelUsado),
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          additionalProperties: false,
          required: [
            "titulo",
            "resumo",
            "pontos_principais",
            "providencias_sugeridas",
            "cliente_mencionado",
            "setor_sugerido",
            "assunto_sugerido",
          ],
          properties: {
            titulo: { type: "string" },
            resumo: { type: "string" },
            pontos_principais: {
              type: "array",
              items: { type: "string" },
            },
            providencias_sugeridas: {
              type: "array",
              items: { type: "string" },
            },
            cliente_mencionado: {
              type: "object",
              additionalProperties: false,
              required: ["nome", "cnpj"],
              properties: {
                nome: { type: "string" },
                cnpj: { type: "string" },
              },
            },
            setor_sugerido: { type: "string" },
            assunto_sugerido: { type: "string" },
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

    // Registra o uso de tokens (para o painel de custos).
    await recordUsage({
      model: modelUsado,
      op: "resumo",
      inputTokens: response.usageMetadata?.promptTokenCount,
      outputTokens: response.usageMetadata?.candidatesTokenCount,
    });

    // 3) Valida e normaliza o JSON recebido.
    return {
      srtPath,
      resumo: parseResumoJson(rawText),
    };
  } catch (error) {
    throw normalizeGeminiError(error);
  }
}
