import { Redis } from "@upstash/redis";
import { getErrorMessage } from "../lib/errors";

// Redis (Upstash/KV) para cachear a cotacao ENTRE execucoes serverless (o cache
// em memoria nao sobrevive a instancias frias na Vercel).
let redisFx: Redis | null = null;
function getRedisFx(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  if (!redisFx) redisFx = new Redis({ url, token });
  return redisFx;
}

// Precos do Gemini em USD por 1 milhao de tokens (input/output).
// ATENCAO: valores de referencia — CONFIRMAR os precos atuais em
// https://ai.google.dev/gemini-api/docs/pricing e ajustar aqui se mudar.
export interface Preco {
  input: number; // USD / 1M tokens de entrada
  output: number; // USD / 1M tokens de saida
}

const PRECOS: Record<string, Preco> = {
  // gemini-2.5-pro (contexto <=200k): CONFIRMAR em ai.google.dev/pricing.
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-flash-8b": { input: 0.0375, output: 0.15 },
  "gemini-1.5-pro": { input: 1.25, output: 5.0 },
  "gemini-1.0-pro": { input: 0.5, output: 1.5 },
};

// Preco padrao quando o modelo nao esta na tabela (usa o do 2.5-flash).
const PRECO_PADRAO: Preco = { input: 0.3, output: 2.5 };

export function precoDoModelo(model: string): Preco {
  return PRECOS[model] || PRECO_PADRAO;
}

export function custoUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = precoDoModelo(model);
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}

// --- Cambio USD -> BRL: automatico, com varias fontes + cache (Redis + memoria).
// Fontes tentadas na ordem; a 1a que responder vale. AwesomeAPI (BR) as vezes e
// bloqueada em datacenter (Vercel), por isso ha fallback(s) que funcionam de nuvem.
const FX_KEY = "fx:usdbrl";
const FX_TTL_SEG = 6 * 60 * 60; // 6h
const FONTES_FX: { nome: string; url: string; extrair: (d: unknown) => number }[] =
  [
    {
      nome: "awesomeapi",
      url: "https://economia.awesomeapi.com.br/json/last/USD-BRL",
      extrair: (d) =>
        Number((d as { USDBRL?: { bid?: string } })?.USDBRL?.bid),
    },
    {
      nome: "open.er-api",
      url: "https://open.er-api.com/v6/latest/USD",
      extrair: (d) => Number((d as { rates?: { BRL?: number } })?.rates?.BRL),
    },
  ];

let cotacaoCache: { valor: number; expiraEm: number } | null = null;

async function lerCotacaoRedis(): Promise<number | null> {
  const r = getRedisFx();
  if (!r) return null;
  try {
    const v = await r.get<string | number>(FX_KEY);
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
async function salvarCotacaoRedis(valor: number): Promise<void> {
  const r = getRedisFx();
  if (!r) return;
  try {
    await r.set(FX_KEY, String(valor), { ex: FX_TTL_SEG });
  } catch {
    /* best-effort */
  }
}

export async function getUsdBrl(): Promise<number> {
  const fallback = Number(process.env.GEMINI_USD_BRL) || 5.4;

  // 1) cache em memoria (instancia quente)
  if (cotacaoCache && Date.now() < cotacaoCache.expiraEm) {
    return cotacaoCache.valor;
  }
  // 2) cache no Redis (sobrevive a instancias frias)
  const doRedis = await lerCotacaoRedis();
  if (doRedis) {
    cotacaoCache = { valor: doRedis, expiraEm: Date.now() + 30 * 60 * 1000 };
    return doRedis;
  }
  // 3) busca nas fontes, na ordem
  for (const f of FONTES_FX) {
    try {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) {
        console.warn(`[pricing] ${f.nome} HTTP ${res.status}`);
        continue;
      }
      const valor = f.extrair(await res.json());
      if (Number.isFinite(valor) && valor > 0) {
        cotacaoCache = {
          valor,
          expiraEm: Date.now() + FX_TTL_SEG * 1000,
        };
        await salvarCotacaoRedis(valor);
        console.log(`[pricing] cotacao USD-BRL=${valor} via ${f.nome}`);
        return valor;
      }
      console.warn(`[pricing] ${f.nome} sem valor valido`);
    } catch (error) {
      console.warn(`[pricing] falha ${f.nome}: ${getErrorMessage(error)}`);
    }
  }

  console.warn(`[pricing] todas as fontes falharam -> fallback ${fallback}`);
  return fallback;
}
