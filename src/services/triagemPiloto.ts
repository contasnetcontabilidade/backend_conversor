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

// Dois gatilhos (redesenho de 10/11/2026, "bandeja + aviso"):
// - chegada: o e-mail que parece pedido vai para a bandeja, em silencio. Cobre
//   o pedido que ninguem respondeu (pedido do dono).
// - resposta: quando a pessoa responde, a sugestao vira "respondida" e o app
//   avisa. Na Fase 0, 38 de 41 chamados reais tinham resposta, e so 18 das 609
//   sugestoes sem chamado do Alberto: e o momento em que o chamado nasce.
const GATILHOS_DO_PILOTO: readonly TipoGatilho[] = ["chegada", "resposta"];
// Confianca minima para virar sugestao (guardada na bandeja). Abaixo disso a
// triagem fica so registrada (ainda serve de exemplo para o aprendizado).
export const LIMIAR_SUGESTAO = 0.7;
// O que a pessoa VE e o que dispara o aviso: o app esconde as abaixo do limiar
// dela, atras do "Mostrar todas". 0,85 pela revisao humana da Fase 0 (dono,
// 10/11/2026): de 0,85 para cima, 12 eram chamado e 0 alarme falso; entre 0,70
// e 0,85, 3 eram chamado e 8 nao eram.
export const LIMIAR_PADRAO = 0.85;
// "Aprende com quem dispensa": DISPENSAS_PARA_SUBIR "nao e chamado" seguidos
// sobem o limiar DA PESSOA; abrir chamado de uma sugestao desce de volta.
export const LIMIAR_QUEM_DISPENSA = 0.9;
const DISPENSAS_PARA_SUBIR = 5;
// Conversa com desfecho (virou chamado, nao e chamado...) nao volta a ser
// sugerida por 30 dias, nem quando chega resposta nova nela.
const ENCERRADA_SEG = 30 * 24 * 3600;
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
// Conversas ja vistas na janela que ainda nao fechou (mais de MAX_CONVERSAS de
// uma vez). Sem isto a conferencia pegava sempre as mesmas 10 do topo da busca
// e nunca chegava nas outras (achado no 1o dia do piloto, 10/11/2026).
const keyVistas = (conta: string) => `triagem:vistas:${conta}`;
const VISTAS_SEG = 2 * 24 * 3600;
const keyTrava = (conta: string) => `triagem:trava:${conta}`;
const keyFeito = (conta: string, messageId: string) => `triagem:feito:${conta}:${messageId}`;
const keyEncerrada = (conta: string, threadId: string) => `triagem:encerrada:${conta}:${threadId}`;
const keyDispensas = (conta: string) => `triagem:dispensas:${conta}`;

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
  // A pessoa respondeu a conversa: e o que dispara o aviso no app. Ausente em
  // sugestao gravada antes do redesenho de 10/11 (= nao respondida).
  respondeu?: boolean;
  respondidaEm?: number;
}

// O desfecho e o ROTULO do aprendizado (Fase 2). So "nao_e_chamado" e exemplo
// negativo; os outros dois botoes do "Nao e chamado" tem desfecho proprio:
// - "nao_e_para_mim": caixa compartilhada; o e-mail pode ser chamado de outra
//   pessoa (pedido do dono em 10/11/2026). Como negativo, ensinaria o modelo
//   que pedido de verdade nao e chamado.
// - "ja_era_chamado": virou chamado por outro caminho (ligacao, Chat, outra
//   caixa). Para o modelo, e um acerto da sugestao.
export type Desfecho =
  | "virou_chamado"
  | "ja_era_chamado"
  | "nao_e_para_mim"
  | "nao_e_chamado"
  | "ignorada";

// O app mostra esta lista (vem na resposta da conferencia): motivo novo nao
// precisa de versao nova do app.
export const MOTIVOS_NAO_E_CHAMADO: ReadonlyArray<{
  valor: string;
  rotulo: string;
  desfecho: Desfecho;
}> = [
  { valor: "nao_e_para_mim", rotulo: "Não é para mim", desfecho: "nao_e_para_mim" },
  { valor: "aviso_automatico", rotulo: "Propaganda ou aviso automático", desfecho: "nao_e_chamado" },
  { valor: "ja_virou_chamado", rotulo: "Já virou chamado", desfecho: "ja_era_chamado" },
  { valor: "nao_e_pedido", rotulo: "Não é pedido de cliente", desfecho: "nao_e_chamado" },
  { valor: "outro", rotulo: "Outro", desfecho: "nao_e_chamado" },
];

export function desfechoDoMotivo(motivo: string): Desfecho | null {
  return MOTIVOS_NAO_E_CHAMADO.find((m) => m.valor === motivo)?.desfecho ?? null;
}

// O que o app precisa para desenhar os botoes (sem o desfecho, que e interno).
export const MOTIVOS_PARA_O_APP = MOTIVOS_NAO_E_CHAMADO.map(({ valor, rotulo }) => ({ valor, rotulo }));

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
  // Respondidas primeiro (sao as do aviso), depois as mais novas.
  return validas.sort(
    (a, b) => Number(!!b.respondeu) - Number(!!a.respondeu) || b.quando - a.quando,
  );
}

// Confianca minima desta pessoa: sobe para quem dispensa muito (ver
// LIMIAR_QUEM_DISPENSA). O app usa para esconder as de baixo e para o aviso.
export async function limiarDaPessoa(email: string): Promise<number> {
  const n = Number(await getRedis().get(keyDispensas(conta(email)))) || 0;
  return n >= DISPENSAS_PARA_SUBIR ? LIMIAR_QUEM_DISPENSA : LIMIAR_PADRAO;
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
  const r = getRedis();
  const removidas = await r.hdel(keySugestoes(c), threadId);
  if (!removidas) return false;
  await registrarNaLista({ tipo: "desfecho", conta: c, threadId, desfecho, ...(motivo ? { motivo } : {}) });
  // "Ignorada" nao encerra: se a pessoa responder depois, a conversa pode
  // voltar como respondida (e ai sim avisar).
  if (desfecho !== "ignorada") {
    await r.set(keyEncerrada(c, threadId), "1", { ex: ENCERRADA_SEG });
  }
  // So o "nao e chamado" de verdade conta como dispensa. "Nao e para mim" e
  // "ja virou chamado" nao dizem que a IA errou.
  if (desfecho === "nao_e_chamado") {
    await r.incr(keyDispensas(c));
  } else if (desfecho === "virou_chamado") {
    await r.del(keyDispensas(c));
  }
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
    // Conta nova no piloto: a janela comeca 24 h atras e fica FIXA ate ser
    // vista inteira (por isso o cursor ja e gravado aqui).
    let cursor = Number(await r.get(keyCursor(c))) || 0;
    if (!cursor) {
      cursor = inicio - PRIMEIRA_VEZ_MS + SOBREPOSICAO_MS;
      await r.set(keyCursor(c), String(cursor));
    }
    const desde = cursor - SOBREPOSICAO_MS;
    const { ids } = await buscarThreads(c, `after:${Math.floor(desde / 1000)} -in:chats ${BUSCA_FORA}`);
    // As que ja estao na bandeja tambem entram: atividade nova nelas pode ser
    // a resposta da pessoa, que e o que dispara o aviso (sem gastar IA).
    const pendentes = await r.hgetall<Record<string, unknown>>(keySugestoes(c));
    const naBandeja = new Map<string, SugestaoTriagem>();
    for (const v of Object.values(pendentes || {})) {
      const s = lerSugestao(v);
      if (s) naBandeja.set(s.threadId, s);
    }
    const vistas = new Set((await r.smembers(keyVistas(c))) || []);
    const fila = ids.filter((t) => !vistas.has(t));
    const agora = fila.slice(0, MAX_CONVERSAS);

    let prox = 0;
    await Promise.all(
      Array.from({ length: Math.min(PARALELO, agora.length) }, async () => {
        while (prox < agora.length) {
          const threadId = agora[prox++];
          const gasto = await triarConversa(c, threadId, desde, ctx.setor, naBandeja.get(threadId)).catch((e) => {
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
    // O cursor so anda quando a janela foi vista inteira. Ate la, as conversas
    // ja vistas ficam anotadas e a proxima conferencia continua da seguinte.
    if (sobrou) {
      if (agora.length) {
        await r.sadd(keyVistas(c), agora[0], ...agora.slice(1));
        await r.expire(keyVistas(c), VISTAS_SEG);
      }
    } else {
      await r.set(keyCursor(c), String(inicio));
      await r.del(keyVistas(c));
    }
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
  naBandeja?: SugestaoTriagem,
): Promise<{ inTok: number; outTok: number; triadas: number; novas: number }> {
  const msgs = await obterThreadParaTriagem(c, threadId);
  const mt = msgs.map((m) => paraTriagem(m, c));
  const total = { inTok: 0, outTok: 0, triadas: 0, novas: 0 };

  // Ja esta na bandeja: so falta saber se a pessoa respondeu. Sem IA.
  if (naBandeja) {
    if (!naBandeja.respondeu) {
      const resposta = mt
        .filter((m) => m.daConta && m.quando > naBandeja.quando)
        .sort((a, b) => a.quando - b.quando)[0];
      if (resposta) await marcarRespondida(c, naBandeja, resposta.quando);
    }
    return total;
  }
  if (await getRedis().get(keyEncerrada(c, threadId))) return total;

  const gatilhos = gatilhosDaThread(mt, desde).filter((g) => GATILHOS_DO_PILOTO.includes(g.tipo));
  // Virou sugestao pela chegada nesta mesma conferencia: a resposta que vem
  // depois so marca como respondida, sem pagar a IA de novo.
  let sugerida: SugestaoTriagem | null = null;
  for (const g of gatilhos) {
    if (g.tipo === "resposta" && sugerida) {
      await marcarRespondida(c, sugerida, g.quando);
      continue;
    }
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
      const ehSugestao = res.decisao === "sim" && res.confianca >= LIMIAR_SUGESTAO;
      await registrarNaLista({
        ...base,
        decisao: res.decisao,
        confianca: res.confianca,
        categoria: res.categoria,
        motivo: res.motivo,
        sugerida: ehSugestao,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
      });
      if (ehSugestao) {
        sugerida = await salvarSugestao(c, g, threadId, assunto, res);
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

// "quando" e sempre o do e-mail RECEBIDO (tambem no gatilho de resposta): e
// com ele que se descobre, depois, se a pessoa respondeu.
async function salvarSugestao(
  c: string,
  g: Gatilho,
  threadId: string,
  assunto: string,
  res: { motivo: string; categoria: string; confianca: number },
): Promise<SugestaoTriagem> {
  const s: SugestaoTriagem = {
    threadId,
    messageId: g.recebida.id,
    assunto,
    deNome: g.recebida.fromNome,
    deEmail: g.recebida.fromEmail,
    quando: g.recebida.quando,
    motivo: res.motivo,
    categoria: res.categoria,
    confianca: res.confianca,
    sugeridaEm: Date.now(),
    ...(g.tipo === "resposta" ? { respondeu: true, respondidaEm: g.quando } : {}),
  };
  await getRedis().hset(keySugestoes(c), { [threadId]: JSON.stringify(s) });
  return s;
}

// A pessoa respondeu uma conversa que ja estava na bandeja. Vai tambem para a
// lista do aprendizado: "respondeu" e o sinal mais forte da Fase 0.
async function marcarRespondida(c: string, s: SugestaoTriagem, quando: number): Promise<void> {
  const nova: SugestaoTriagem = { ...s, respondeu: true, respondidaEm: quando };
  await getRedis().hset(keySugestoes(c), { [s.threadId]: JSON.stringify(nova) });
  await registrarNaLista({ tipo: "resposta", conta: c, threadId: s.threadId, quando: new Date(quando).toISOString() });
  Object.assign(s, nova);
}
