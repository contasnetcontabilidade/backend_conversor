import { Redis } from "@upstash/redis";
import { getErrorMessage } from "../lib/errors";
import { CLAUDE_MODEL } from "./claude";
import { registrarErro } from "./erros";
import { buscarThreads, obterThreadParaTriagem } from "./gmailApi";
import {
  FalhaTriagem,
  gatilhosDaThread,
  montarTrecho,
  paraTriagem,
  TRIAGEM_PROMPT_VERSION,
  triarEmail,
  type Gatilho,
  type TipoGatilho,
} from "./triagem";
import { recordUsage } from "./usage";

// Piloto da triagem (Fase 1, decisoes de 09 e 10/11/2026): o app confere a
// caixa a cada ~12 min, com o app aberto, e mostra no topo da aba E-mails as
// conversas que podem virar chamado. So SUGERE: quem cria e a pessoa.
//
// Ligado so para as contas do SET `triagem:piloto` (scripts/triagem-piloto.ts),
// sem deploy para mudar quem participa. Fora da lista, a rota responde
// "inativo" sem ler a caixa nem gastar IA.
//
// Tudo que a triagem ve e decide vai para `triagem:list` (append-only, sem
// teto durante o piloto, como o feedback): a copia diaria leva para o DuckDB da
// rede, onde vira a base do aprendizado. Cada registro guarda o TRECHO que a IA
// leu (decisao do dono: guardar por tempo indeterminado).

// Medidas da Fase 0 (10/11/2026, caixas do suporte): na chegada a triagem
// achou 40 de 41 chamados reais; depois da resposta ela sugere ~70% de tudo o
// que a pessoa respondeu. A sugestao fica na lista ate a pessoa agir, entao a
// chegada ja cobre quem so registra depois de responder.
const GATILHOS_DO_PILOTO: readonly TipoGatilho[] = ["chegada"];
// Confianca minima para virar sugestao. Abaixo disso a triagem fica so
// registrada (ainda serve de exemplo para o aprendizado).
export const LIMIAR_SUGESTAO = 0.7;
// A Fase 0 achou 5 dos 36 chamados do Gabriel na aba Foruns (e-mail mandado
// para endereco de grupo): so Promocoes e Social ficam fora.
const BUSCA_FORA = "-category:promotions -category:social";
// Uma conferencia cabe folgada no tempo de uma funcao da Vercel; o que sobrar
// fica para a proxima (o cursor so anda quando tudo foi visto).
const MAX_CONVERSAS = 10;
const PARALELO = 3;
const PRIMEIRA_VEZ_MS = 24 * 3600_000; // conta nova no piloto olha so o ultimo dia
const SOBREPOSICAO_MS = 5 * 60_000; // e-mail que chega no meio de uma conferencia
const TRAVA_SEG = 120; // uma conferencia por vez por conta (app aberto em 2 PCs)
const FEITO_SEG = 30 * 24 * 3600; // a mensagem-gatilho ja triada nao paga IA de novo
const VALIDADE_SUGESTAO_MS = 7 * 24 * 3600_000; // sem acao em 7 dias = "ignorada"

const KEY_PILOTO = "triagem:piloto";
export const KEY_LISTA = "triagem:list";
const keySugestoes = (conta: string) => `triagem:sug:${conta}`;
const keyCursor = (conta: string) => `triagem:cursor:${conta}`;
const keyTrava = (conta: string) => `triagem:trava:${conta}`;
const keyFeito = (conta: string, messageId: string) => `triagem:feito:${conta}:${messageId}`;

let redis: Redis | null = null;
function getRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    // Sem Redis nao ha cursor nem lista: a conferencia leria a caixa inteira
    // de novo a cada vez. Melhor falhar visivel do que gastar em silencio.
    throw new Error("Triagem sem Redis configurado (KV_REST_API_URL/TOKEN).");
  }
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

const conta = (email: string) => String(email || "").trim().toLowerCase();

export async function estaNoPiloto(email: string): Promise<boolean> {
  return (await getRedis().sismember(KEY_PILOTO, conta(email))) === 1;
}
export async function listarPiloto(): Promise<string[]> {
  return ((await getRedis().smembers(KEY_PILOTO)) || []).sort();
}
export async function entrarNoPiloto(email: string): Promise<void> {
  await getRedis().sadd(KEY_PILOTO, conta(email));
}
export async function sairDoPiloto(email: string): Promise<void> {
  await getRedis().srem(KEY_PILOTO, conta(email));
}

export interface SugestaoTriagem {
  threadId: string;
  messageId: string;
  assunto: string;
  deNome: string;
  deEmail: string;
  quando: number; // ms do e-mail que disparou
  motivo: string;
  categoria: string;
  confianca: number;
  sugeridaEm: number;
}

export type Desfecho = "virou_chamado" | "nao_e_chamado" | "ignorada";

export const MOTIVOS_NAO_E_CHAMADO = [
  "aviso_automatico",
  "ja_virou_chamado",
  "nao_e_pedido",
  "outro",
] as const;

function lerSugestao(v: unknown): SugestaoTriagem | null {
  try {
    const s = typeof v === "string" ? JSON.parse(v) : v;
    return s && typeof s === "object" && (s as SugestaoTriagem).threadId ? (s as SugestaoTriagem) : null;
  } catch {
    return null;
  }
}

async function registrarNaLista(registro: Record<string, unknown>): Promise<void> {
  await getRedis().lpush(KEY_LISTA, JSON.stringify({ ts: new Date().toISOString(), ...registro }));
}

// Sugestoes pendentes, mais novas primeiro. As vencidas saem aqui mesmo e
// viram desfecho "ignorada": isso tambem e rotulo para o aprendizado.
export async function listarSugestoes(email: string): Promise<SugestaoTriagem[]> {
  const c = conta(email);
  const bruto = (await getRedis().hgetall<Record<string, unknown>>(keySugestoes(c))) || {};
  const agora = Date.now();
  const validas: SugestaoTriagem[] = [];
  for (const v of Object.values(bruto)) {
    const s = lerSugestao(v);
    if (!s) continue;
    if (agora - (s.sugeridaEm || s.quando) > VALIDADE_SUGESTAO_MS) {
      await registrarDesfecho(c, s.threadId, "ignorada");
      continue;
    }
    validas.push(s);
  }
  return validas.sort((a, b) => b.quando - a.quando);
}

// Tira a sugestao da lista e anota o que a pessoa fez com ela. false = nao
// havia sugestao pendente para essa conversa (nada e anotado).
export async function registrarDesfecho(
  email: string,
  threadId: string,
  desfecho: Desfecho,
  motivo?: string,
): Promise<boolean> {
  const c = conta(email);
  const removidas = await getRedis().hdel(keySugestoes(c), threadId);
  if (!removidas) return false;
  await registrarNaLista({ tipo: "desfecho", conta: c, threadId, desfecho, ...(motivo ? { motivo } : {}) });
  return true;
}

export interface ResultadoConferencia {
  sugestoes: SugestaoTriagem[];
  conferidoEm: number | null; // null = outra conferencia desta conta estava em andamento
  triadas: number;
  novas: number;
  pendentes: number; // conversas que ficaram para a proxima conferencia
}

export async function conferirCaixa(
  email: string,
  ctx: { setor?: string } = {},
): Promise<ResultadoConferencia> {
  const c = conta(email);
  const r = getRedis();
  const pegou = await r.set(keyTrava(c), "1", { nx: true, ex: TRAVA_SEG });
  if (pegou !== "OK") {
    return { sugestoes: await listarSugestoes(c), conferidoEm: null, triadas: 0, novas: 0, pendentes: 0 };
  }
  const inicio = Date.now();
  let inTok = 0;
  let outTok = 0;
  let triadas = 0;
  let novas = 0;
  try {
    const cursor = Number(await r.get(keyCursor(c))) || 0;
    const desde = cursor ? cursor - SOBREPOSICAO_MS : inicio - PRIMEIRA_VEZ_MS;
    const { ids } = await buscarThreads(c, `after:${Math.floor(desde / 1000)} -in:chats ${BUSCA_FORA}`);
    const pendentes = await r.hgetall<Record<string, unknown>>(keySugestoes(c));
    const jaSugeridas = new Set(Object.keys(pendentes || {}));
    const fila = ids.filter((t) => !jaSugeridas.has(t));
    const agora = fila.slice(0, MAX_CONVERSAS);

    let prox = 0;
    await Promise.all(
      Array.from({ length: Math.min(PARALELO, agora.length) }, async () => {
        while (prox < agora.length) {
          const threadId = agora[prox++];
          const gasto = await triarConversa(c, threadId, desde, ctx.setor).catch((e) => {
            // Conversa que nao abre (apagada no meio) nao derruba as outras.
            console.warn(`[triagem] ${threadId} nao triada: ${getErrorMessage(e)}`);
            return null;
          });
          if (!gasto) continue;
          inTok += gasto.inTok;
          outTok += gasto.outTok;
          triadas += gasto.triadas;
          novas += gasto.novas;
        }
      }),
    );

    const sobrou = fila.length - agora.length;
    // O cursor so anda quando tudo foi visto: o que sobrou entra na proxima,
    // e as ja triadas sao puladas pela marca de "feito".
    if (!sobrou) await r.set(keyCursor(c), String(inicio));
    return { sugestoes: await listarSugestoes(c), conferidoEm: inicio, triadas, novas, pendentes: sobrou };
  } finally {
    await r.del(keyTrava(c)).catch(() => undefined);
    // Um registro por conferencia, nao por e-mail: cada registro de uso custa
    // ~10 comandos do Redis, e o plano gratuito nao aguentaria um por triagem.
    // SEM ramal de proposito: o /admin calcula "IA sem chamado" por ramal
    // (gasto - o que virou chamado), e a triagem nunca vira chamado por si.
    // Ela aparece no total e na fonte "Triagem de e-mail".
    if (inTok || outTok) {
      await recordUsage({
        model: CLAUDE_MODEL,
        op: "resumo",
        inputTokens: inTok,
        outputTokens: outTok,
        fonte: "triagem",
      });
    }
  }
}

async function triarConversa(
  c: string,
  threadId: string,
  desde: number,
  setor?: string,
): Promise<{ inTok: number; outTok: number; triadas: number; novas: number }> {
  const msgs = await obterThreadParaTriagem(c, threadId);
  const gatilhos = gatilhosDaThread(
    msgs.map((m) => paraTriagem(m, c)),
    desde,
  ).filter((g) => GATILHOS_DO_PILOTO.includes(g.tipo));
  const total = { inTok: 0, outTok: 0, triadas: 0, novas: 0 };
  for (const g of gatilhos) {
    const primeiraVez = (await getRedis().set(keyFeito(c, g.messageId), "1", { nx: true, ex: FEITO_SEG })) === "OK";
    if (!primeiraVez) continue;
    const msg = msgs.find((m) => m.id === g.recebida.id) || msgs[0];
    const assunto = msg?.subject || "";
    const trecho = montarTrecho(g);
    const base = {
      tipo: "triagem",
      conta: c,
      setor: setor || "",
      threadId,
      messageId: g.messageId,
      gatilho: g.tipo,
      quando: new Date(g.quando).toISOString(),
      assunto,
      remetenteDominio: g.recebida.fromEmail.split("@")[1] || "",
      abaGmail: [...new Set(msgs.flatMap((m) => m.labelIds))].filter((l) => l.startsWith("CATEGORY_")),
      trecho,
      versaoPrompt: TRIAGEM_PROMPT_VERSION,
      modelo: CLAUDE_MODEL,
    };
    try {
      const res = await triarEmail({ setor, assunto, gatilho: g, trecho });
      total.inTok += res.inputTokens;
      total.outTok += res.outputTokens;
      total.triadas++;
      const sugerida = res.decisao === "sim" && res.confianca >= LIMIAR_SUGESTAO;
      await registrarNaLista({
        ...base,
        decisao: res.decisao,
        confianca: res.confianca,
        categoria: res.categoria,
        motivo: res.motivo,
        sugerida,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
      });
      if (sugerida) {
        await salvarSugestao(c, g, threadId, assunto, res);
        total.novas++;
      }
    } catch (e) {
      if (e instanceof FalhaTriagem) {
        total.inTok += e.inputTokens;
        total.outTok += e.outputTokens;
      }
      const mensagem = getErrorMessage(e);
      console.error(`[triagem] falhou em ${threadId}: ${mensagem}`);
      await registrarNaLista({ ...base, erro: mensagem });
      // A marca de "feito" fica: repetir a cada 12 min uma triagem que o
      // modelo recusa so gastaria. O erro fica visivel no /admin/erros.
      await registrarErro({
        ts: new Date().toISOString(),
        origem: "backend",
        tipo: "erro",
        mensagem: `triagem falhou: ${mensagem}`,
        contexto: "triagem:conferir",
      }).catch(() => undefined);
    }
  }
  return total;
}

async function salvarSugestao(
  c: string,
  g: Gatilho,
  threadId: string,
  assunto: string,
  res: { motivo: string; categoria: string; confianca: number },
): Promise<void> {
  const s: SugestaoTriagem = {
    threadId,
    messageId: g.messageId,
    assunto,
    deNome: g.recebida.fromNome,
    deEmail: g.recebida.fromEmail,
    quando: g.quando,
    motivo: res.motivo,
    categoria: res.categoria,
    confianca: res.confianca,
    sugeridaEm: Date.now(),
  };
  await getRedis().hset(keySugestoes(c), { [threadId]: JSON.stringify(s) });
}
