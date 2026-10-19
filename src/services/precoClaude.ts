import { Redis } from "@upstash/redis";
import { waitUntil } from "@vercel/functions";
import { getErrorMessage } from "../lib/errors";
import { registrarErro } from "./erros";
import {
  precoClaudeNoDia,
  precoDoModelo,
  type HistoricoPrecoClaude,
  type PrecoClaude,
} from "./pricing";

// Preco do Claude Haiku 5.5 conferido no site da Anthropic no maximo 1x por dia
// (pedido do dono em 19/10/2026: o painel acompanha a pagina de precos sozinho).
// Nao existe API de preco; a fonte e a pagina publica, que vem pronta do
// servidor (sem precisar de navegador). Leitura defensiva: se o layout mudar e
// a leitura falhar, fica valendo o ultimo preco lido e o motivo vai para o
// /admin/erros — o painel nunca passa a usar um numero que nao conferiu.

const URL_PRECOS = "https://claude.com/pricing";
const KEY_HISTORICO = "preco:claude-haiku-5-5:historico"; // HASH desde -> JSON
const KEY_ESTADO = "preco:claude-haiku-5-5:estado"; // ultima verificacao
// Marcador com TTL: enquanto existir, ninguem confere de novo. E tambem a trava
// entre instancias da Vercel (SET NX), para nao baixar a pagina varias vezes.
const KEY_PROXIMA = "preco:claude-haiku-5-5:proxima";
const ESPERA_OK_SEG = 24 * 3600;
const ESPERA_FALHA_SEG = 6 * 3600; // falha tenta de novo antes de um dia

let redis: Redis | null = null;
function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

export interface EstadoPrecoClaude {
  verificadoEm?: string; // ultima leitura do site que deu certo (ISO)
  falhaDesde?: string; // primeira falha sem leitura boa depois (ISO)
  motivoFalha?: string;
}

const hoje = () => new Date().toISOString().slice(0, 10);

function plausivel(p: PrecoClaude): boolean {
  const v = [p.input, p.output, p.inputLongo, p.outputLongo];
  return (
    v.every((n) => Number.isFinite(n) && n > 0 && n < 100) &&
    p.output > p.input &&
    p.inputLongo >= p.input &&
    p.outputLongo >= p.output
  );
}

// Le o bloco do Haiku 5.5 no HTML da pagina de precos. Em 19/10/2026 o texto
// (sem as tags) era: "Haiku 5.5 ... Input Prompts ≤ 100K tokens $0.10 / MTok
// Prompts > 100K tokens $0.50 / MTok Output Prompts ≤ 100K tokens $0.50 / MTok
// Prompts > 100K tokens $2.50 / MTok". O "Prompt caching" vem antes, com
// "Read/Write", e nao casa com "Input/Output". null = nao reconheceu.
export function extrairPrecoHaiku(html: string): PrecoClaude | null {
  const texto = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&le;/g, "≤")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  const inicio = texto.search(/Haiku 5\.5/i);
  if (inicio < 0) return null;
  // O bloco vai ate o proximo modelo, para nunca ler o preco de outro.
  const depois = texto.slice(inicio + "Haiku 5.5".length);
  const fim = depois.search(/\b(Opus|Sonnet|Haiku|Fable|Mythos) \d/i);
  const bloco = depois.slice(0, fim >= 0 ? fim : 2000);
  const faixas = (rotulo: string): [number, number] | null => {
    const m = bloco.match(
      new RegExp(
        `${rotulo}\\s+Prompts\\s*(?:≤|<=)\\s*100K tokens\\s*\\$([\\d.]+)\\s*/\\s*MTok\\s*` +
          `Prompts\\s*>\\s*100K tokens\\s*\\$([\\d.]+)\\s*/\\s*MTok`,
        "i",
      ),
    );
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const entrada = faixas("Input");
  const saida = faixas("Output");
  if (!entrada || !saida) return null;
  const p = {
    input: entrada[0],
    inputLongo: entrada[1],
    output: saida[0],
    outputLongo: saida[1],
  };
  return plausivel(p) ? p : null;
}

export async function lerHistoricoPrecoClaude(): Promise<HistoricoPrecoClaude> {
  const r = getRedis();
  if (!r) return [];
  try {
    const hash =
      (await r.hgetall<Record<string, unknown>>(KEY_HISTORICO)) || {};
    return Object.entries(hash)
      .map(([desde, v]) => ({
        desde,
        ...((typeof v === "string" ? JSON.parse(v) : v) as PrecoClaude),
      }))
      .filter(plausivel)
      .sort((a, b) => a.desde.localeCompare(b.desde));
  } catch (error) {
    console.warn("[precoClaude] falha ao ler o historico:", getErrorMessage(error));
    return [];
  }
}

// Preco que vale hoje: o ultimo lido do site ou, antes da primeira leitura, a
// tabela do codigo.
export function precoClaudeVigente(historico: HistoricoPrecoClaude): PrecoClaude {
  const curto = precoClaudeNoDia("claude-haiku-5-5", hoje(), historico);
  const longo = precoClaudeNoDia("claude-haiku-5-5-acima-100k", hoje(), historico);
  const tabCurto = precoDoModelo("claude-haiku-5-5");
  const tabLongo = precoDoModelo("claude-haiku-5-5-acima-100k");
  return {
    input: (curto || tabCurto).input,
    output: (curto || tabCurto).output,
    inputLongo: (longo || tabLongo).input,
    outputLongo: (longo || tabLongo).output,
  };
}

const iguais = (a: PrecoClaude, b: PrecoClaude) =>
  a.input === b.input &&
  a.output === b.output &&
  a.inputLongo === b.inputLongo &&
  a.outputLongo === b.outputLongo;

const fmt = (p: PrecoClaude) =>
  `entrada US$ ${p.input} / saida US$ ${p.output} (acima de 100k: ${p.inputLongo} / ${p.outputLongo})`;

// Confere o site se ja passou o prazo (24h; 6h depois de falha). Sem Redis nao
// confere: sem o marcador, baixaria 1,2 MB a cada chamada.
export async function conferirPrecoClaudeSeVencido(): Promise<void> {
  const r = getRedis();
  if (!r) return;
  const agora = new Date().toISOString();
  const minha = await r.set(KEY_PROXIMA, agora, {
    nx: true,
    ex: ESPERA_OK_SEG,
  });
  if (minha !== "OK") return;

  const anterior = await lerEstadoPrecoClaude();
  try {
    const res = await fetch(URL_PRECOS, {
      headers: { "User-Agent": "ContasAssistente/1.0 (backend-conversor)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lido = extrairPrecoHaiku(await res.text());
    if (!lido) {
      throw new Error(
        "bloco do Haiku 5.5 nao reconhecido (layout da pagina mudou?) ou valores fora do esperado",
      );
    }
    const historico = await lerHistoricoPrecoClaude();
    const vigente = precoClaudeVigente(historico);
    // A 1a leitura entra mesmo igual a tabela: e o que marca o preco como
    // "conferido no site". Depois, so mudanca de preco vira entrada nova.
    if (!historico.length || !iguais(lido, vigente)) {
      await r.hset(KEY_HISTORICO, { [hoje()]: JSON.stringify(lido) });
    }
    if (!iguais(lido, vigente)) {
      await registrarErro({
        ts: agora,
        origem: "backend",
        tipo: "preco",
        mensagem: `Preco do Claude Haiku 5.5 mudou em ${URL_PRECOS}: era ${fmt(vigente)}, agora ${fmt(lido)}. Vale a partir de ${hoje()}.`,
        contexto: "preco:claude:mudou",
      }).catch(() => undefined);
    }
    await r.set(KEY_ESTADO, JSON.stringify({ verificadoEm: agora }));
  } catch (error) {
    const motivo = getErrorMessage(error);
    console.warn(`[precoClaude] leitura de ${URL_PRECOS} falhou: ${motivo}`);
    await r.set(KEY_PROXIMA, agora, { ex: ESPERA_FALHA_SEG });
    await r.set(
      KEY_ESTADO,
      JSON.stringify({
        verificadoEm: anterior.verificadoEm,
        falhaDesde: anterior.falhaDesde || agora,
        motivoFalha: motivo.slice(0, 300),
      }),
    );
    await registrarErro({
      ts: agora,
      origem: "backend",
      tipo: "preco",
      mensagem: `Leitura do preco do Claude em ${URL_PRECOS} falhou — segue valendo o ultimo preco. ${motivo}`.slice(
        0,
        500,
      ),
      contexto: "preco:claude:leitura",
    }).catch(() => undefined);
  }
}

// Para chamar depois de usar o Claude: confere em segundo plano, sem a resposta
// do resumo esperar a pagina de precos.
export function agendarConferenciaPrecoClaude(): void {
  const tarefa = conferirPrecoClaudeSeVencido().catch((error) =>
    console.warn("[precoClaude] conferencia falhou:", getErrorMessage(error)),
  );
  try {
    waitUntil(tarefa);
  } catch {
    // Fora da Vercel o waitUntil nao existe; a tarefa segue best-effort.
  }
}

export async function lerEstadoPrecoClaude(): Promise<EstadoPrecoClaude> {
  const r = getRedis();
  if (!r) return {};
  try {
    const v = await r.get<unknown>(KEY_ESTADO);
    if (!v) return {};
    return (typeof v === "string" ? JSON.parse(v) : v) as EstadoPrecoClaude;
  } catch {
    return {};
  }
}
