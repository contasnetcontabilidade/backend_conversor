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
  // Assunto/tipo do chamado sugerido em texto livre (fallback).
  assunto_sugerido: string;
  // Assunto ESCOLHIDO pela IA a partir da lista de tipos do Suite (id + nome).
  // Vazio quando a lista nao foi fornecida ou nada se encaixou.
  assunto_escolhido: { id: string; nome: string };
};

export type ResumoInput = {
  audioPath?: string;
  srtPath?: string;
  model?: string;
  // Lista de assuntos/tipos do Suite para a IA escolher UM (id + nome).
  // Quando fornecida, a IA escolhe da lista (mais preciso que o texto livre).
  assuntosDisponiveis?: Array<{ id: string; nome: string }>;
  // Identidade da ligacao (ramal/usuario do escritorio) para atribuir o custo
  // da IA no painel de consumo. Opcional; quando ausente, o custo fica "nao atribuido".
  ramal?: string;
  usuario?: string;
  // Texto direto a resumir (ex.: corpo de um e-mail). Quando presente, NAO le
  // arquivo .srt do disco — usa este texto como conteudo.
  text?: string;
  // Origem do conteudo, ajusta o prompt. Padrao: "ligacao".
  origem?: "ligacao" | "email";
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

  const tituloBruto = String(parsed.titulo ?? "").trim();
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
  const assuntoSugerido = String(parsed.assunto_sugerido ?? "").trim();
  const escolhaRaw = isRecord(parsed.assunto_escolhido)
    ? parsed.assunto_escolhido
    : {};
  const assuntoEscolhido = {
    id: String(escolhaRaw.id ?? "").trim(),
    nome: String(escolhaRaw.nome ?? "").trim(),
  };

  // So falha se o resumo estiver vazio (aí o retry cobre). Se faltar so o
  // titulo, deriva do inicio do resumo — nao descarta um resumo bom.
  if (!resumo) {
    throw new AppError({
      statusCode: 502,
      code: "GEMINI_MISSING_FIELDS",
      message: "Gemini retornou JSON sem o campo resumo.",
      details: { raw: rawText.slice(0, 500) },
    });
  }
  const titulo = tituloBruto || resumo.slice(0, 60);

  return {
    titulo,
    resumo,
    pontos_principais: pontos,
    providencias_sugeridas: providencias,
    cliente_mencionado: clienteMencionado,
    assunto_sugerido: assuntoSugerido,
    assunto_escolhido: assuntoEscolhido,
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
  // 1) Origem do conteudo: texto direto (e-mail) OU arquivo .srt (transcricao).
  let srtPath = "";
  let transcricao: string;
  if (input.text != null) {
    transcricao = String(input.text);
  } else {
    srtPath = resolveSrtPath(input);
    if (!fs.existsSync(srtPath)) {
      throw new AppError({
        statusCode: 404,
        code: "SRT_NOT_FOUND",
        message: `Arquivo .srt nao encontrado: ${srtPath}`,
      });
    }
    transcricao = await readFile(srtPath, "utf-8");
  }

  // Guarda: transcricao vazia/inaudivel (comum em ligacao interna curta) ->
  // nao chama o modelo; devolve um resumo minimo (evita "vazio" confuso).
  const soTexto = transcricao
    .replace(
      /\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{3}/g,
      " ",
    )
    .replace(/[^\p{L}]/gu, "")
    .trim();
  const origem = input.origem || "ligacao";
  if (soTexto.length < 10) {
    return {
      srtPath,
      resumo: {
        titulo:
          origem === "email"
            ? "E-mail sem conteudo"
            : "Ligacao sem conteudo transcrito",
        resumo:
          origem === "email"
            ? "Conteudo do e-mail vazio."
            : "Transcricao vazia ou inaudivel.",
        pontos_principais: [],
        providencias_sugeridas: [],
        cliente_mencionado: { nome: "", cnpj: "" },
        assunto_sugerido: "",
        assunto_escolhido: { id: "", nome: "" },
      },
    };
  }

  const contexto =
    origem === "email"
      ? "Voce registra chamados de atendimento de um escritorio de contabilidade, a partir de um E-MAIL recebido de um cliente."
      : "Voce registra chamados de atendimento telefonico de um escritorio de contabilidade, a partir da transcricao de uma ligacao.";
  const fontePalavra = origem === "email" ? "no e-mail" : "na ligacao";
  const prompt = `${contexto}
Escreva em portugues do Brasil, tom profissional, claro e objetivo. Retorne APENAS JSON valido,
sem markdown e sem texto fora do JSON.
Campos obrigatorios:
- titulo: string (assunto curto do chamado, ate ~80 caracteres)
- resumo: string (resumo executivo do atendimento, 2 a 5 frases: o que o cliente pediu/relatou e o desfecho/pendencia)
- pontos_principais: string[] (os principais topicos/fatos tratados, curtos e objetivos)
- providencias_sugeridas: string[] (acoes/pendencias a executar; array vazio se nao houver)
- cliente_mencionado: objeto { nome: string, cnpj: string } com o nome/razao social e o CNPJ do
  cliente SE aparecerem ${fontePalavra} (inclusive na assinatura); capte o nome mesmo que informal.
  Use string vazia "" quando nao houver.
- assunto_sugerido: string (o tipo/assunto do chamado em poucas palavras, ex.: "Guia do Simples",
  "Folha de pagamento", "Abertura de empresa"; "" se incerto).
- assunto_escolhido: objeto { id: string, nome: string }. Com base no conteudo, escolha na
  "LISTA DE ASSUNTOS DISPONIVEIS" abaixo (quando houver) o item que MELHOR representa o motivo do
  atendimento, e copie o id e o nome EXATAMENTE como aparecem na lista. Escolha o mais especifico que
  se aplique. Se realmente nada se encaixar (ou se nao houver lista), use id e nome vazios.
Nao invente informacoes. Se algo nao aparece no conteudo, deixe vazio.`;

  // Lista de assuntos do Suite para a IA escolher UM (quando fornecida pelo controller).
  const assuntos = input.assuntosDisponiveis || [];
  const blocoAssuntos = assuntos.length
    ? `\n\nLISTA DE ASSUNTOS DISPONIVEIS (escolha EXATAMENTE UM em assunto_escolhido):\n${assuntos
        .map((a) => `- [${a.id}] ${a.nome}`)
        .join("\n")}`
    : "";

  const modelUsado = input.model?.trim() || DEFAULT_GEMINI_MODEL;

  const responseJsonSchema = {
    type: "object",
    additionalProperties: false,
    required: [
      "titulo",
      "resumo",
      "pontos_principais",
      "providencias_sugeridas",
      "cliente_mencionado",
      "assunto_sugerido",
      "assunto_escolhido",
    ],
    properties: {
      titulo: { type: "string" },
      resumo: { type: "string" },
      pontos_principais: { type: "array", items: { type: "string" } },
      providencias_sugeridas: { type: "array", items: { type: "string" } },
      cliente_mencionado: {
        type: "object",
        additionalProperties: false,
        required: ["nome", "cnpj"],
        properties: { nome: { type: "string" }, cnpj: { type: "string" } },
      },
      assunto_sugerido: { type: "string" },
      assunto_escolhido: {
        type: "object",
        additionalProperties: false,
        required: ["id", "nome"],
        properties: { id: { type: "string" }, nome: { type: "string" } },
      },
    },
  };

  // Retry robusto: queremos SEMPRE gerar o resumo quando a transcricao tem
  // conteudo, mesmo que demore um pouco mais. 1a tentativa com thinking desligado
  // (barato); as seguintes com o thinking padrao (mais confiavel). Re-tenta em
  // falhas transitorias: vazio/JSON invalido, quota/429 e erros de upstream (5xx).
  const MAX_TENTATIVAS = 5;
  let ultimoErro: unknown;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      const response = await getGeminiClient().models.generateContent({
        model: modelUsado,
        contents: `${prompt}${blocoAssuntos}\n\n${
          origem === "email" ? "E-MAIL" : "TRANSCRICAO"
        }:\n${transcricao}`,
        config: {
          thinkingConfig:
            tentativa === 1 ? thinkingConfigFor(modelUsado) : undefined,
          responseMimeType: "application/json",
          responseJsonSchema,
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

      const resumo = parseResumoJson(rawText);

      await recordUsage({
        model: modelUsado,
        op: "resumo",
        inputTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
        ramal: input.ramal,
        usuario: input.usuario,
      });

      return { srtPath, resumo };
    } catch (error) {
      ultimoErro = error;
      const vazioOuInvalido =
        error instanceof AppError &&
        [
          "GEMINI_EMPTY_RESPONSE",
          "GEMINI_INVALID_JSON",
          "GEMINI_INVALID_PAYLOAD",
          "GEMINI_MISSING_FIELDS",
        ].includes(error.code);
      const msg = getErrorMessage(error).toLowerCase();
      const status =
        isRecord(error) && typeof error.status === "number" ? error.status : 0;
      // quota/rate-limit por minuto: espera mais (o limite diario nao recupera).
      const quota =
        status === 429 ||
        /quota|resource_exhausted|429|rate limit|too many/.test(msg);
      // erro transitorio de upstream (5xx / indisponibilidade / timeout de rede).
      const upstream =
        status >= 500 ||
        /unavailable|internal error|overloaded|timeout|deadline|502|503|504|econnreset|network|fetch failed/.test(
          msg,
        );
      if (tentativa < MAX_TENTATIVAS && (vazioOuInvalido || quota || upstream)) {
        const espera = quota
          ? Math.min(3000 * tentativa, 8000)
          : upstream
            ? Math.min(1500 * tentativa, 6000)
            : 500;
        console.warn(
          `[gemini] falha no resumo (${
            quota ? "quota/429" : upstream ? "upstream" : "vazio/invalido"
          }) tentativa ${tentativa}/${MAX_TENTATIVAS}; re-tentando em ${espera}ms.`,
        );
        await new Promise((r) => setTimeout(r, espera));
        continue;
      }
      throw normalizeGeminiError(error);
    }
  }
  throw normalizeGeminiError(ultimoErro);
}
