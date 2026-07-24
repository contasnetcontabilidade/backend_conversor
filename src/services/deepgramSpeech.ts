import fs from "fs";
import path from "path";
import { AppError, getErrorMessage } from "../lib/errors";
import { recordUsage } from "./usage";

type IdentidadeUso = {
  ramal?: string;
  usuario?: string;
  fonte?: "ligacao" | "email" | "resumo";
  // Funcionarios do escritorio NESTA ligacao (do relatorio GoTo). Entram como
  // keyterms para melhorar a grafia de nomes proprios. Escala sozinho: gente
  // nova aparece nos participantes da propria ligacao, sem cadastro manual.
  nomesConhecidos?: string[];
};

// Termos-chave FIXOS (nome do escritorio, jargao) — configuraveis por env, sem
// depender do relatorio da chamada. Padrao ja cobre "Contas Contabilidade"
// (que a transcricao as vezes ouvia como "Contos"). Os nomes dos FUNCIONARIOS
// vem por ligacao (nomesConhecidos), entao nao entram aqui.
function keytermsFixos(): string[] {
  const raw = (process.env.DEEPGRAM_KEYTERMS || "Contas Contabilidade").trim();
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Monta a lista de termos (fixos + nomes da ligacao), sem repetir.
function montarKeyterms(identidade: IdentidadeUso): string[] {
  const nomes = (identidade.nomesConhecidos || [])
    .map((n) => String(n || "").trim())
    .filter((n) => n.length >= 2);
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const t of [...keytermsFixos(), ...nomes]) {
    const k = t.toLowerCase();
    if (!vistos.has(k)) {
      vistos.add(k);
      out.push(t);
    }
  }
  return out.slice(0, 100); // limite defensivo
}

// Deepgram Speech-to-Text (Nova-3) — arquivo gravado, REST sincrono.
// POST do audio bruto -> transcript no JSON. Ativa so quando DEEPGRAM_API_KEY
// existe (senao fica dormante). Gate por ramal fica no transcricao.ts.
// Privacidade: mip_opt_out=true (audio do cliente NAO entra no treino da Deepgram).

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

export function deepgramConfigurado(): boolean {
  return !!(process.env.DEEPGRAM_API_KEY || "").trim();
}

interface DeepgramResponse {
  metadata?: { duration?: number }; // duracao do audio em segundos (p/ o custo)
  results?: {
    channels?: {
      alternatives?: { transcript?: string }[];
    }[];
  };
}

// Junta o transcript de cada canal (mono = 1 canal).
function montarTranscript(data: DeepgramResponse): string {
  const canais = data?.results?.channels || [];
  const partes: string[] = [];
  for (const ch of canais) {
    const t = String(ch?.alternatives?.[0]?.transcript || "").trim();
    if (t) partes.push(t);
  }
  return partes.join("\n").trim();
}

export async function transcreverAudioDeepgram(
  audioPath: string,
  identidade: IdentidadeUso = {},
): Promise<{ transcript: string }> {
  const key = (process.env.DEEPGRAM_API_KEY || "").trim();
  if (!key) {
    throw new AppError({
      statusCode: 500,
      code: "DEEPGRAM_NAO_CONFIGURADO",
      message: "Deepgram nao configurado (DEEPGRAM_API_KEY).",
    });
  }

  const base = (process.env.DEEPGRAM_ENDPOINT || "https://api.deepgram.com")
    .trim()
    .replace(/\/+$/, "");
  const model = (process.env.DEEPGRAM_MODEL || "nova-3").trim();
  const language = (process.env.DEEPGRAM_LANGUAGE || "pt-BR").trim();

  const params = new URLSearchParams({
    model,
    language,
    smart_format: "true",
    mip_opt_out: "true", // audio do cliente nao vai pro treino da Deepgram
  });

  // Boost de nomes proprios (nome do escritorio + funcionarios da ligacao).
  // Nova-3 usa "keyterm" (aceita frases); Nova-2 e anteriores usam "keywords"
  // (por palavra — entao quebramos as frases, ex.: "Contas Contabilidade" ->
  // "Contas" e "Contabilidade", reforcando cada uma).
  const termos = montarKeyterms(identidade);
  if (termos.length) {
    const usaKeyterm = /nova-3/i.test(model);
    const aEnviar = usaKeyterm
      ? termos
      : Array.from(
          new Set(
            termos
              .flatMap((t) => t.split(/\s+/))
              .map((w) => w.trim())
              .filter((w) => w.length >= 2),
          ),
        );
    for (const t of aEnviar) params.append(usaKeyterm ? "keyterm" : "keywords", t);
  }

  const url = `${base}/v1/listen?${params.toString()}`;

  const buf = await fs.promises.readFile(audioPath);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${key}`,
        "Content-Type": inferMime(audioPath),
      },
      body: new Uint8Array(buf),
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) {
    throw new AppError({
      statusCode: 502,
      code: "DEEPGRAM_UNREACHABLE",
      message: "Nao foi possivel conectar ao Deepgram.",
      details: { cause: getErrorMessage(error) },
    });
  }

  const corpo = await res.text();
  if (!res.ok) {
    throw new AppError({
      statusCode: res.status === 401 || res.status === 403 ? 401 : 502,
      code: "DEEPGRAM_ERROR",
      message: `Falha no Deepgram (HTTP ${res.status}).`,
      details: { corpo: corpo.slice(0, 500) },
    });
  }

  let data: DeepgramResponse;
  try {
    data = JSON.parse(corpo) as DeepgramResponse;
  } catch {
    data = {};
  }

  // Registra o gasto no painel de custos: Deepgram cobra por MINUTO de audio,
  // entao guardamos a duracao (segundos). model "deepgram-<model>" para o preco.
  const audioSec = Math.round(Number(data?.metadata?.duration) || 0);
  if (audioSec > 0) {
    await recordUsage({
      model: `deepgram-${model}`,
      op: "transcricao",
      audioSec,
      ramal: identidade.ramal,
      usuario: identidade.usuario,
      fonte: identidade.fonte,
    }).catch(() => undefined);
  }

  return { transcript: montarTranscript(data) };
}
