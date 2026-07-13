// Estrategia de barateamento de tokens do Gemini.
//
// O modo "thinking" (pensamento) e cobrado como token de saida e, para as
// tarefas deste projeto — transcrever audio e resumir em JSON estruturado —
// ele nao agrega qualidade proporcional ao custo. Aqui centralizamos a
// escolha da configuracao de thinking por familia de modelo:
//
// - Gemini 2.x / 1.5 (flash): desliga o thinking com thinkingBudget = 0.
// - Gemini 3: nao permite desligar totalmente; usa o nivel minimo ("low").
//
// Tudo e sobrescrivel por variavel de ambiente para ajuste rapido sem deploy.

import type { ThinkingConfig } from "@google/genai";

export function thinkingConfigFor(model: string): ThinkingConfig | undefined {
  const m = (model || "").toLowerCase();

  // Gemini 3: so da para reduzir (nao desligar) — usa o nivel minimo.
  if (m.includes("gemini-3")) {
    const level = (process.env.GEMINI_THINKING_LEVEL || "low").trim() || "low";
    return { thinkingLevel: level as ThinkingConfig["thinkingLevel"] };
  }

  // Gemini 2.5 PRO: NAO permite desligar o thinking (budget 0 e rejeitado pela
  // API). Usa o budget minimo valido (128) para minimizar o custo sem quebrar a
  // chamada. Sobrescrivel por GEMINI_THINKING_BUDGET_PRO.
  if (m.includes("2.5") && m.includes("pro")) {
    const parsed = Number(process.env.GEMINI_THINKING_BUDGET_PRO ?? "128");
    const thinkingBudget =
      Number.isFinite(parsed) && parsed >= 128 ? parsed : 128;
    return { thinkingBudget, includeThoughts: false };
  }

  // Gemini 2.x / 1.5 (flash): desliga o thinking (budget 0 por padrao).
  if (
    m.includes("2.5") ||
    m.includes("2.0") ||
    m.includes("1.5") ||
    m.includes("flash")
  ) {
    const parsed = Number(process.env.GEMINI_THINKING_BUDGET ?? "0");
    const thinkingBudget = Number.isFinite(parsed) ? parsed : 0;
    return { thinkingBudget, includeThoughts: false };
  }

  return undefined;
}
