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
import { carregarModelo, notaDoModelo, taxaAuditoria } from "./triagemModelo";
import { recordUsage } from "./usage";

// Piloto da triagem (Fase 1, decisoes de 09 e 10/11/2026): o app confere a
// caixa a cada ~12 min, com o app aberto, e mostra no topo da aba E-mails as
// conversas que podem virar chamado. So SUGERE: quem cria e a pessoa.
//
// Ligado so para as contas do SET `triagem:piloto` (scripts/triagem-piloto.ts),
// sem deploy para mudar quem participa. Fora da lista, a rota responde
// "inativo" sem ler a caixa nem gastar IA.
//
// Tudo que a triagem ve e decide vai para `triagem:list` (append-only): a
// copia-analise leva para o DuckDB da rede, onde vira a base do aprendizado, e
// desde 11/11/2026 apaga do Redis o que ja copiou. Cada registro guarda o
// TRECHO que a IA leu (decisao do dono: guardar por tempo indeterminado).
//
// Comandos do Redis: o Upstash gratuito da ~500 mil por mes, e a conferencia
// roda a cada 20 min em cada app do piloto. Por isso cada leitura aqui foi
// contada (teste "conferencia sem nada novo" em triagemPiloto.test.ts).

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
// Sem trava de "uma conferencia por vez" (havia ate 11/11/2026): o "feito"
// abaixo, com SET NX, ja garante que duas conferencias juntas (app aberto em 2
// PCs) paguem a IA uma vez so por e-mail, e a trava custava 2 comandos em toda
// conferencia.
const FEITO_SEG = 30 * 24 * 3600; // a mensagem-gatilho ja triada nao paga IA de novo
const VALIDADE_SUGESTAO_MS = 7 * 24 * 3600_000; // sem acao em 7 dias = "ignorada"

const KEY_PILOTO = "triagem:piloto";
export const KEY_LISTA = "triagem:list";
const keySugestoes = (conta: string) => `triagem:sug:${conta}`;
const keyCursor = (conta: string) => `triagem:cursor:${conta}`;
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

// Quem esta no piloto muda raramente e e perguntado em toda conferencia de
// todo app. A resposta fica 30 min na memoria da funcao da Vercel (mais que
// os 20 min entre conferencias, senao nunca acertaria): sair do piloto pelo
// script vale em ate 30 min. Entrar vale na proxima pergunta do app, que fora
// do piloto e a cada 6 h.
const PILOTO_CACHE_MS = 30 * 60_000;
const pilotoEmCache = new Map<string, { dentro: boolean; em: number }>();

export async function estaNoPiloto(email: string): Promise<boolean> {
  const c = conta(email);
  const guardado = pilotoEmCache.get(c);
  if (guardado && Date.now() - guardado.em < PILOTO_CACHE_MS) return guardado.dentro;
  const dentro = (await getRedis().sismember(KEY_PILOTO, c)) === 1;
  pilotoEmCache.set(c, { dentro, em: Date.now() });
  return dentro;
}
export async function listarPiloto(): Promise<string[]> {
  return ((await getRedis().smembers(KEY_PILOTO)) || []).sort();
}
export async function entrarNoPiloto(email: string): Promise<void> {
  await getRedis().sadd(KEY_PILOTO, conta(email));
  pilotoEmCache.delete(conta(email));
}
export async function sairDoPiloto(email: string): Promise<void> {
  await getRedis().srem(KEY_PILOTO, conta(email));
  pilotoEmCache.delete(conta(email));
}

// O cursor da conferencia: onde comeca a janela da proxima busca e, enquanto a
// janela nao foi vista inteira (mais de MAX_CONVERSAS de uma vez), as conversas
// dela ja vistas. Sem as vistas, a conferencia pegava sempre as mesmas 10 do
// topo da busca e nunca chegava nas outras (1o dia do piloto, 10/11/2026).
// Tudo numa chave so desde 11/11/2026: eram o cursor e um SET de vistas,
// 4 comandos por conferencia; agora sao 1 leitura e 1 gravacao.
interface CursorDaConta {
  janela: number; // ms
  vistas: string[];
}

function lerCursor(v: unknown): CursorDaConta {
  let bruto = v;
  if (typeof bruto === "string" && bruto.startsWith("{")) {
    try {
      bruto = JSON.parse(bruto);
    } catch {
      bruto = null;
    }
  }
  if (bruto && typeof bruto === "object") {
    const o = bruto as Partial<CursorDaConta>;
    return { janela: Number(o.janela) || 0, vistas: Array.isArray(o.vistas) ? o.vistas.map(String) : [] };
  }
  // Formato de antes de 11/11/2026: so o numero.
  return { janela: Number(bruto) || 0, vistas: [] };
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

async function lerBandeja(c: string): Promise<SugestaoTriagem[]> {
  const bruto = (await getRedis().hgetall<Record<string, unknown>>(keySugestoes(c))) || {};
  return Object.values(bruto)
    .map(lerSugestao)
    .filter((s): s is SugestaoTriagem => !!s);
}

// Sugestoes pendentes, mais novas primeiro. As vencidas saem aqui mesmo e
// viram desfecho "ignorada": isso tambem e rotulo para o aprendizado.
export async function listarSugestoes(email: string): Promise<SugestaoTriagem[]> {
  const c = conta(email);
  return organizarSugestoes(c, await lerBandeja(c));
}

async function organizarSugestoes(c: string, bandeja: SugestaoTriagem[]): Promise<SugestaoTriagem[]> {
  const agora = Date.now();
  const validas: SugestaoTriagem[] = [];
  for (const s of bandeja) {
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
  return limiarPelasDispensas(await getRedis().get(keyDispensas(conta(email))));
}

function limiarPelasDispensas(dispensas: unknown): number {
  return (Number(dispensas) || 0) >= DISPENSAS_PARA_SUBIR ? LIMIAR_QUEM_DISPENSA : LIMIAR_PADRAO;
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
  conferidoEm: number;
  triadas: number;
  novas: number;
  filtradas: number; // descartadas pelo robozinho, sem chamar a IA
  pendentes: number; // conversas que ficaram para a proxima conferencia
  limiar: number; // o de limiarDaPessoa, lido junto com o cursor
}

export async function conferirCaixa(
  email: string,
  ctx: { setor?: string } = {},
): Promise<ResultadoConferencia> {
  const c = conta(email);
  const r = getRedis();
  const inicio = Date.now();
  let inTok = 0;
  let outTok = 0;
  let triadas = 0;
  let novas = 0;
  let filtradas = 0;
  try {
    // Cursor e dispensas (o limiar da pessoa) numa leitura so.
    const [cursorBruto, dispensas] = await r.mget<[unknown, unknown]>(keyCursor(c), keyDispensas(c));
    const cursor = lerCursor(cursorBruto);
    // Conta nova no piloto: a janela comeca 24 h atras e fica FIXA ate ser
    // vista inteira.
    const janela = cursor.janela || inicio - PRIMEIRA_VEZ_MS + SOBREPOSICAO_MS;
    const desde = janela - SOBREPOSICAO_MS;
    const { ids } = await buscarThreads(c, `after:${Math.floor(desde / 1000)} -in:chats ${BUSCA_FORA}`);
    // As que ja estao na bandeja tambem entram: atividade nova nelas pode ser
    // a resposta da pessoa, que e o que dispara o aviso (sem gastar IA). O
    // mapa e atualizado durante a conferencia e vira a resposta no fim, sem
    // ler a bandeja de novo.
    const bandeja = new Map<string, SugestaoTriagem>();
    for (const s of await lerBandeja(c)) bandeja.set(s.threadId, s);
    const vistas = new Set(cursor.vistas);
    const fila = ids.filter((t) => !vistas.has(t));
    const agora = fila.slice(0, MAX_CONVERSAS);

    let prox = 0;
    await Promise.all(
      Array.from({ length: Math.min(PARALELO, agora.length) }, async () => {
        while (prox < agora.length) {
          const threadId = agora[prox++];
          const gasto = await triarConversa(c, threadId, desde, ctx.setor, bandeja).catch((e) => {
            // Conversa que nao abre (apagada no meio) nao derruba as outras.
            console.warn(`[triagem] ${threadId} nao triada: ${getErrorMessage(e)}`);
            return null;
          });
          if (!gasto) continue;
          inTok += gasto.inTok;
          outTok += gasto.outTok;
          triadas += gasto.triadas;
          novas += gasto.novas;
          filtradas += gasto.filtradas;
        }
      }),
    );

    const sobrou = fila.length - agora.length;
    // O cursor so anda quando a janela foi vista inteira. Ate la, as conversas
    // ja vistas ficam anotadas e a proxima conferencia continua da seguinte.
    const proximo: CursorDaConta = sobrou
      ? { janela, vistas: [...cursor.vistas, ...agora] }
      : { janela: inicio, vistas: [] };
    await r.set(keyCursor(c), JSON.stringify(proximo));
    return {
      sugestoes: await organizarSugestoes(c, [...bandeja.values()]),
      conferidoEm: inicio,
      triadas,
      novas,
      filtradas,
      pendentes: sobrou,
      limiar: limiarPelasDispensas(dispensas),
    };
  } finally {
    // Um registro por conferencia, nao por e-mail: cada registro de uso custa
    // ~6 comandos do Redis (usage.ts), e o plano gratuito nao aguentaria um
    // por triagem.
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
  setor: string | undefined,
  bandeja: Map<string, SugestaoTriagem>,
): Promise<{ inTok: number; outTok: number; triadas: number; novas: number; filtradas: number }> {
  const msgs = await obterThreadParaTriagem(c, threadId);
  const mt = msgs.map((m) => paraTriagem(m, c));
  const total = { inTok: 0, outTok: 0, triadas: 0, novas: 0, filtradas: 0 };

  // Ja esta na bandeja: so falta saber se a pessoa respondeu. Sem IA.
  const naBandeja = bandeja.get(threadId);
  if (naBandeja) {
    if (!naBandeja.respondeu) {
      const resposta = mt
        .filter((m) => m.daConta && m.quando > naBandeja.quando)
        .sort((a, b) => a.quando - b.quando)[0];
      if (resposta) await marcarRespondida(c, naBandeja, resposta.quando);
    }
    return total;
  }
  const gatilhos = gatilhosDaThread(mt, desde).filter((g) => GATILHOS_DO_PILOTO.includes(g.tipo));
  // Virou sugestao pela chegada nesta mesma conferencia: a resposta que vem
  // depois so marca como respondida, sem pagar a IA de novo.
  let sugerida: SugestaoTriagem | null = null;
  // So pergunta se a conversa esta encerrada quando ha e-mail novo para triar:
  // a que so voltou pela sobreposicao da busca para no "feito", sem outra
  // leitura do Redis.
  let encerrada: boolean | null = null;
  for (const g of gatilhos) {
    if (g.tipo === "resposta" && sugerida) {
      await marcarRespondida(c, sugerida, g.quando);
      continue;
    }
    const primeiraVez = (await getRedis().set(keyFeito(c, g.messageId), "1", { nx: true, ex: FEITO_SEG })) === "OK";
    if (!primeiraVez) continue;
    if (encerrada === null) encerrada = !!(await getRedis().get(keyEncerrada(c, threadId)));
    if (encerrada) return total;
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
    // Robozinho (triagemModelo.ts): nota antes de pagar a IA. Abaixo do corte,
    // o e-mail e descartado; 1 em 10 desses vai para a IA mesmo assim
    // ("auditoria"), e e isso que mede o erro do robozinho em producao. A nota
    // fica gravada sempre, ao lado da decisao da IA.
    const robo = await carregarModelo();
    const nota = robo
      ? notaDoModelo(robo, {
          assunto,
          trecho,
          remetenteDominio: base.remetenteDominio,
          gatilho: g.tipo,
          abas: base.abaGmail,
        })
      : null;
    const descartar = !!robo && nota !== null && nota < robo.corte;
    const auditoria = descartar && Math.random() < taxaAuditoria();
    const doRobo = robo
      ? { notaModelo: nota, versaoModelo: robo.versao, ...(auditoria ? { auditoria: true } : {}) }
      : {};
    if (descartar && !auditoria) {
      await registrarNaLista({ ...base, ...doRobo, filtrado: true });
      total.filtradas++;
      continue;
    }
    try {
      const res = await triarEmail({ setor, assunto, gatilho: g, trecho });
      total.inTok += res.inputTokens;
      total.outTok += res.outputTokens;
      total.triadas++;
      const ehSugestao = res.decisao === "sim" && res.confianca >= LIMIAR_SUGESTAO;
      await registrarNaLista({
        ...base,
        ...doRobo,
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
        bandeja.set(threadId, sugerida);
        total.novas++;
      }
    } catch (e) {
      if (e instanceof FalhaTriagem) {
        total.inTok += e.inputTokens;
        total.outTok += e.outputTokens;
      }
      const mensagem = getErrorMessage(e);
      console.error(`[triagem] falhou em ${threadId}: ${mensagem}`);
      await registrarNaLista({ ...base, ...doRobo, erro: mensagem });
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
