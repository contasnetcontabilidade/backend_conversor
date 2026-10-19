import Anthropic from "@anthropic-ai/sdk";
import { agendarConferenciaPrecoClaude } from "./precoClaude";

// Modelo FIXO por decisao do dono (19/10/2026): sempre o Claude Haiku 5.5, o
// Claude mais barato. Nao e configuravel por env de proposito — trocar de
// modelo ou de provedor e decisao dele, nao de quem mexe no deploy.
export const CLAUDE_MODEL = "claude-haiku-5-5";

// Acima de 100 mil tokens de entrada a requisicao INTEIRA e cobrada na tabela
// mais cara do Haiku 5.5. Como o painel soma tokens por dia e perde o tamanho de
// cada chamada, essas chamadas sao gravadas com outro nome de modelo (ver
// pricing.ts) — e o que mantem o custo exato.
const LIMITE_PROMPT_CURTO = 100_000;
export const CLAUDE_MODEL_ACIMA_100K = `${CLAUDE_MODEL}-acima-100k`;

let client: Anthropic | null = null;

// Sem a chave o Claude fica dormente e o resumo segue no Gemini — remover
// ANTHROPIC_API_KEY da Vercel e o rollback, sem deploy.
export function claudeConfigurado(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || "").trim();
}

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: (process.env.ANTHROPIC_API_KEY || "").trim(),
      // O resumo leva ~4 s. 45 s com 1 re-tentativa (o SDK so repete erro
      // temporario: timeout, 408/409/429, 5xx, queda de conexao) poe o Gemini
      // de reserva em ~1,5 min no pior caso, em vez de prender a funcao da
      // Vercel esperando um provedor fora do ar. Chave recusada nao repete.
      timeout: 45_000,
      maxRetries: 1,
    });
  }
  return client;
}

export type RespostaClaude = {
  text: string;
  // "refusal" ou "max_tokens" = o texto pode nao seguir o schema. Nao lanca
  // aqui: esses tokens tambem sao cobrados, e quem chama precisa grava-los
  // no painel antes de tratar a falha.
  stopReason: Anthropic.StopReason | null;
  inputTokens: number;
  // Ja inclui os tokens de thinking, que a Anthropic cobra como saida.
  outputTokens: number;
  // Nome de modelo para o painel de custos (muda acima de 100k tokens).
  modeloCusto: string;
};

// Gera um JSON que segue `schema` (structured outputs: a API garante o
// formato quando a resposta termina normalmente).
export async function gerarJsonClaude(
  prompt: string,
  schema: Record<string, unknown>,
): Promise<RespostaClaude> {
  const resp = await getClient().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    output_config: {
      // "low" venceu no teste de 19/10/2026 (19 casos do zz_eval x2, prompt
      // 2026-09-22): 32/38 contra 30/38 do "medium" e 28/38 do Gemini
      // 2.5-flash, e foi o mais barato. O padrao do Haiku 5.5 e "medium".
      effort: "low",
      format: { type: "json_schema", schema },
    },
    messages: [{ role: "user", content: prompt }],
  });
  // Quem usa o Claude confere o preco no site (no maximo 1x/dia): assim o
  // preco acompanha o site mesmo nos dias em que ninguem abre o painel.
  agendarConferenciaPrecoClaude();

  // Le por tipo, nao por posicao: com thinking ligado a resposta pode comecar
  // com blocos "thinking" antes do texto.
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    text,
    stopReason: resp.stop_reason,
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
    modeloCusto:
      resp.usage.input_tokens > LIMITE_PROMPT_CURTO
        ? CLAUDE_MODEL_ACIMA_100K
        : CLAUDE_MODEL,
  };
}
