import { Redis } from "@upstash/redis";
import { getErrorMessage } from "../lib/errors";

// O "robozinho" da triagem (filtro com auditoria, decisao do dono em
// 11/11/2026): um modelo pequeno, treinado para imitar a decisao da IA, da a
// nota de cada e-mail ANTES de chamar a IA. Abaixo do corte, o e-mail e
// descartado sem pagar IA; 1 em cada 10 desses vai para a IA mesmo assim, para
// medir o erro do modelo em producao (triagemPiloto.ts).
//
// O modelo e uma regressao logistica sobre TF-IDF de palavras genericas,
// treinado em Python (scikit-learn) com os e-mails da Fase 0. Ele mora no
// Redis, NAO no codigo: o repositorio e publico, e mesmo o vocabulario
// generico tem sobrenomes comuns. Sem modelo no Redis, nada e filtrado.
//
// Na Fase 0 (prova: 3 caixas do DP que o modelo nunca viu), com corte 0,02 ele
// descartou ~40% dos e-mails sem perder nenhuma sugestao visivel (0 de 919) nem
// chamado real (0 de 32); no suporte, ~62%.

export const KEY_MODELO = "triagem:modelo";
const CACHE_MS = 10 * 60_000; // trocar o modelo no Redis vale em ate 10 min

export interface ModeloTriagem {
  versao: string;
  corte: number; // nota abaixo disso = descartar sem chamar a IA
  intercepto: number;
  palavras: Record<string, [number, number]>; // termo -> [idf, peso]
  meta: Record<string, number>; // etiqueta -> peso (colega/externo, gat_*, category_*)
  treinadoCom?: number;
}

export interface EntradaModelo {
  assunto: string;
  trecho: string;
  remetenteDominio: string;
  gatilho: string;
  abas: string[]; // CATEGORY_* do Gmail
}

// A mesma limpeza do TfidfVectorizer(strip_accents="unicode") do scikit-learn:
// minusculas e sem acento. Se a limpeza diferisse da do treino, "não" e "nao"
// cairiam em colunas diferentes e a nota sairia errada sem erro nenhum.
export function normalizar(texto: string): string {
  const minusc = String(texto || "").toLowerCase();
  // O scikit-learn so decompoe texto que nao e ASCII puro.
  if (/^[\x00-\x7f]*$/.test(minusc)) return minusc;
  return minusc.normalize("NFKD").replace(/\p{Mn}/gu, "");
}

// Palavras e pares de palavras, como o token_pattern (?u)\b\w\w+\b com
// ngram_range=(1, 2): sequencias de letra/numero/_ com 2+ caracteres.
export function termos(texto: string): string[] {
  const achadas: string[] = normalizar(texto).match(/[\p{L}\p{N}_]+/gu) || [];
  const palavras = achadas.filter((t) => t.length >= 2);
  const pares: string[] = [];
  for (let i = 0; i + 1 < palavras.length; i++) pares.push(`${palavras[i]} ${palavras[i + 1]}`);
  return [...palavras, ...pares];
}

// Etiquetas: o regex de "colega" e o mesmo do treino (ml/exportar.py do copia-analise), de proposito.
function etiquetas(e: EntradaModelo): string[] {
  const colega = /contas(net)?\.com\.br$/.test(String(e.remetenteDominio || "").toLowerCase());
  return [colega ? "colega" : "externo", `gat_${e.gatilho}`, ...e.abas].map((t) => t.toLowerCase());
}

const temChave = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// Chance (0 a 1) de a IA dizer "pode virar chamado".
export function notaDoModelo(m: ModeloTriagem, e: EntradaModelo): number {
  // TF-IDF sublinear (1 + ln da contagem) so com o vocabulario do modelo,
  // normalizado (L2), como no treino.
  const contagem = new Map<string, number>();
  // So chave propria: uma palavra como "constructor" acharia o que o JavaScript
  // tem em todo objeto, e a nota sairia NaN.
  for (const t of termos(`${e.assunto || ""} \n ${e.trecho || ""}`)) {
    if (temChave(m.palavras, t)) contagem.set(t, (contagem.get(t) || 0) + 1);
  }
  const valores: Array<[number, number]> = []; // [tfidf, peso]
  let soma2 = 0;
  for (const [t, n] of contagem) {
    const [idf, peso] = m.palavras[t];
    const v = (1 + Math.log(n)) * idf;
    valores.push([v, peso]);
    soma2 += v * v;
  }
  const norma = Math.sqrt(soma2) || 1;
  let z = m.intercepto;
  for (const [v, peso] of valores) z += (v / norma) * peso;
  for (const t of new Set(etiquetas(e))) if (temChave(m.meta, t)) z += m.meta[t];
  return 1 / (1 + Math.exp(-z));
}

function modeloValido(m: unknown): m is ModeloTriagem {
  const x = m as ModeloTriagem;
  return (
    !!x &&
    typeof x.versao === "string" &&
    typeof x.corte === "number" &&
    x.corte > 0 &&
    x.corte < 0.5 &&
    typeof x.intercepto === "number" &&
    !!x.palavras &&
    typeof x.palavras === "object" &&
    !!x.meta &&
    typeof x.meta === "object"
  );
}

let redis: Redis | null = null;
function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

let cache: { modelo: ModeloTriagem | null; em: number } | null = null;

// O modelo do Redis (com cache de 10 min). null = sem filtro: tudo vai para a
// IA, como antes do robozinho. Falha ao ler tambem cai aqui, com aviso no log.
export async function carregarModelo(): Promise<ModeloTriagem | null> {
  if (cache && Date.now() - cache.em < CACHE_MS) return cache.modelo;
  let modelo: ModeloTriagem | null = null;
  try {
    const r = getRedis();
    const v = r ? await r.get<unknown>(KEY_MODELO) : null;
    const lido = typeof v === "string" ? JSON.parse(v) : v;
    if (lido && !modeloValido(lido)) console.warn("[triagem] modelo no Redis invalido: filtro desligado");
    modelo = modeloValido(lido) ? lido : null;
  } catch (e) {
    console.warn(`[triagem] modelo nao carregou (filtro desligado): ${getErrorMessage(e)}`);
  }
  cache = { modelo, em: Date.now() };
  return modelo;
}

// So para os testes e o script de subir modelo: esquece o cache.
export function esquecerModeloEmCache(): void {
  cache = null;
}

// Quantos dos descartados ainda vao para a IA (auditoria). 0,1 = 1 em 10.
export function taxaAuditoria(): number {
  const bruto = String(process.env.TRIAGEM_AUDITORIA ?? "").trim();
  if (!bruto) return 0.1;
  const v = Number(bruto);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.1;
}

export { modeloValido };
