import { getErrorMessage } from "../lib/errors";

// Precos do Gemini em USD por 1 milhao de tokens (input/output).
// ATENCAO: valores de referencia — CONFIRMAR os precos atuais em
// https://ai.google.dev/gemini-api/docs/pricing e ajustar aqui se mudar.
export interface Preco {
  input: number; // USD / 1M tokens de entrada
  output: number; // USD / 1M tokens de saida
}

const PRECOS: Record<string, Preco> = {
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

// --- Cambio USD -> BRL (cache em memoria de 6h; fallback via env/constante) ---
let cotacaoCache: { valor: number; expiraEm: number } | null = null;

export async function getUsdBrl(): Promise<number> {
  const fallback = Number(process.env.GEMINI_USD_BRL) || 5.4;

  if (cotacaoCache && Date.now() < cotacaoCache.expiraEm) {
    return cotacaoCache.valor;
  }

  try {
    const res = await fetch(
      "https://economia.awesomeapi.com.br/json/last/USD-BRL",
      { signal: AbortSignal.timeout(4000) },
    );
    if (res.ok) {
      const data = (await res.json()) as Record<string, { bid?: string }>;
      const bid = Number(data?.USDBRL?.bid);
      if (Number.isFinite(bid) && bid > 0) {
        cotacaoCache = { valor: bid, expiraEm: Date.now() + 6 * 60 * 60 * 1000 };
        return bid;
      }
    }
  } catch (error) {
    console.warn("[pricing] cotacao indisponivel:", getErrorMessage(error));
  }

  return fallback;
}
