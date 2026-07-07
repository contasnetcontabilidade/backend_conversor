import { Redis } from "@upstash/redis";
import { getErrorMessage } from "../lib/errors";

// Contagem de tokens da IA (Gemini) para o painel de custos.
// Guarda no Upstash: um SET de dias + um HASH por dia com os totais por
// modelo/operacao. Tudo best-effort: nunca derruba o fluxo principal.

let redis: Redis | null = null;
function getRedis(): Redis | null {
  // Aceita nomes do Upstash e da integracao KV da Vercel.
  const url =
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

export type Operacao = "transcricao" | "resumo";

const KEY_DIAS = "uso:dias";
const keyDia = (dia: string) => `uso:d:${dia}`;
const field = (model: string, op: Operacao, metric: "in" | "out" | "calls") =>
  `${model}::${op}::${metric}`;

function hoje(): string {
  // YYYY-MM-DD (UTC) — suficiente para agrupar por dia no painel.
  return new Date().toISOString().slice(0, 10);
}

// Registra o uso de tokens de uma chamada. Best-effort (nao lanca).
export async function recordUsage(params: {
  model: string;
  op: Operacao;
  inputTokens?: number;
  outputTokens?: number;
}): Promise<void> {
  const r = getRedis();
  if (!r) return;

  const model = (params.model || "desconhecido").trim() || "desconhecido";
  const inTok = Math.max(0, Math.floor(params.inputTokens || 0));
  const outTok = Math.max(0, Math.floor(params.outputTokens || 0));
  const dia = hoje();

  try {
    await r.sadd(KEY_DIAS, dia);
    const k = keyDia(dia);
    await Promise.all([
      r.hincrby(k, field(model, params.op, "in"), inTok),
      r.hincrby(k, field(model, params.op, "out"), outTok),
      r.hincrby(k, field(model, params.op, "calls"), 1),
    ]);
  } catch (error) {
    console.warn("[usage] falha ao registrar uso:", getErrorMessage(error));
  }
}

export interface UsoLinha {
  model: string;
  op: Operacao;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface UsoPorDia {
  dia: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface RelatorioUso {
  linhas: UsoLinha[]; // agregado por modelo+operacao (todo o periodo)
  porDia: UsoPorDia[]; // agregado por dia
  configurado: boolean;
}

// Le e agrega todo o uso registrado.
export async function getRelatorioUso(): Promise<RelatorioUso> {
  const r = getRedis();
  if (!r) return { linhas: [], porDia: [], configurado: false };

  const dias = (await r.smembers(KEY_DIAS)) || [];
  const agg = new Map<string, UsoLinha>();
  const porDia: UsoPorDia[] = [];

  for (const dia of dias.sort()) {
    const hash = (await r.hgetall<Record<string, string | number>>(
      keyDia(dia),
    )) || {};
    let diaIn = 0;
    let diaOut = 0;
    let diaCalls = 0;

    for (const [rawField, rawValue] of Object.entries(hash)) {
      const [model, op, metric] = rawField.split("::");
      if (!model || !op || !metric) continue;
      const value = Number(rawValue) || 0;
      const chave = `${model}::${op}`;
      const linha =
        agg.get(chave) ||
        ({ model, op: op as Operacao, inputTokens: 0, outputTokens: 0, calls: 0 } as UsoLinha);

      if (metric === "in") {
        linha.inputTokens += value;
        diaIn += value;
      } else if (metric === "out") {
        linha.outputTokens += value;
        diaOut += value;
      } else if (metric === "calls") {
        linha.calls += value;
        diaCalls += value;
      }
      agg.set(chave, linha);
    }

    porDia.push({ dia, inputTokens: diaIn, outputTokens: diaOut, calls: diaCalls });
  }

  return { linhas: Array.from(agg.values()), porDia, configurado: true };
}
