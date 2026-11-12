import { Redis } from "@upstash/redis";
import { getErrorMessage } from "../lib/errors";
import { registrarErro } from "./erros";
import { bancoDaTriagem } from "./triagemBanco";

// Contagem de tokens da IA (Gemini) para o painel de custos.
// Guarda no Upstash: um SET de dias + um HASH por dia com os totais por
// modelo/operacao. Alem disso, quando a chamada tem um ramal/usuario conhecido,
// grava um HASH paralelo por dia detalhado por ramal (uso:du:<dia>) e o nome do
// usuario de cada ramal (uso:ramais). Tudo best-effort: nunca derruba o fluxo.

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
// "triagem" = a conferencia da caixa do Gmail (sugestoes de chamado). Fica
// separada de "email" porque nao e custo de um chamado aberto.
export type Fonte = "ligacao" | "email" | "resumo" | "chat" | "gravacao" | "triagem";
// "sec" = segundos de audio (provedores cobrados por minuto, ex.: Deepgram).
type Metric = "in" | "out" | "calls" | "sec";

const KEY_DIAS = "uso:dias";
let diaJaAnotado = ""; // ultimo dia que esta instancia ja pos em KEY_DIAS
const KEY_RAMAIS = "uso:ramais"; // HASH ramal -> nome do usuario
// Uso acumulado de UM item (ligacao/e-mail). E o que permite dizer, na hora em
// que o chamado e criado, quanto custou aquele atendimento — e daí atribuir o
// custo a cliente/assunto. Soma transcricao + resumo do mesmo id.
const keyItem = (id: string) => `uso:item:${id}`;
const ITEM_TTL_SEG = 45 * 24 * 3600; // o chamado nasce em minutos; 45d e folga
const keyDia = (dia: string) => `uso:d:${dia}`;
const keyDiaUser = (dia: string) => `uso:du:${dia}`; // detalhe por ramal
const keyDiaFonte = (dia: string) => `uso:df:${dia}`; // detalhe por fonte
const field = (model: string, op: Operacao, metric: Metric) =>
  `${model}::${op}::${metric}`;
const fieldUser = (
  model: string,
  op: Operacao,
  ramal: string,
  metric: Metric,
) => `${model}::${op}::${ramal}::${metric}`;
const fieldFonte = (
  fonte: string,
  model: string,
  op: Operacao,
  metric: Metric,
) => `${fonte}::${model}::${op}::${metric}`;

function hoje(): string {
  // YYYY-MM-DD (UTC) — suficiente para agrupar por dia no painel.
  return new Date().toISOString().slice(0, 10);
}

// Registra o uso de tokens de uma chamada. Best-effort (nao lanca).
// Se `ramal` vier preenchido, tambem contabiliza o consumo atribuido a esse
// ramal/usuario (para o detalhamento por ramal no painel).
export async function recordUsage(params: {
  model: string;
  op: Operacao;
  inputTokens?: number;
  outputTokens?: number;
  audioSec?: number; // segundos de audio (Deepgram e afins, cobrados por minuto)
  ramal?: string;
  usuario?: string;
  fonte?: Fonte;
  // Id do atendimento (conversationSpaceId da ligacao / messageId do e-mail).
  // Opcional: quando vem, o custo fica rastreavel ate o chamado criado.
  itemId?: string;
}): Promise<void> {
  const r = getRedis();
  if (!r) return;

  const model = (params.model || "desconhecido").trim() || "desconhecido";
  const inTok = Math.max(0, Math.floor(params.inputTokens || 0));
  const outTok = Math.max(0, Math.floor(params.outputTokens || 0));
  const sec = Math.max(0, Math.floor(params.audioSec || 0));
  const dia = hoje();
  const ramal = String(params.ramal || "").trim();
  const usuario = String(params.usuario || "").trim();
  const fonte = params.fonte;

  try {
    // O dia so entra no SET uma vez; repetir o SADD em todo registro era um
    // comando do Redis a toa (a triagem registra a cada conferencia). Nada
    // apaga uso:dias, entao lembrar na memoria da funcao basta.
    if (dia !== diaJaAnotado) {
      await r.sadd(KEY_DIAS, dia);
      diaJaAnotado = dia;
    }
    const k = keyDia(dia);
    const ops: Promise<unknown>[] = [
      r.hincrby(k, field(model, params.op, "in"), inTok),
      r.hincrby(k, field(model, params.op, "out"), outTok),
      r.hincrby(k, field(model, params.op, "calls"), 1),
    ];
    if (sec) ops.push(r.hincrby(k, field(model, params.op, "sec"), sec));
    if (ramal) {
      const ku = keyDiaUser(dia);
      ops.push(
        r.hincrby(ku, fieldUser(model, params.op, ramal, "in"), inTok),
        r.hincrby(ku, fieldUser(model, params.op, ramal, "out"), outTok),
        r.hincrby(ku, fieldUser(model, params.op, ramal, "calls"), 1),
      );
      if (sec)
        ops.push(r.hincrby(ku, fieldUser(model, params.op, ramal, "sec"), sec));
      // Guarda/atualiza o nome exibido do ramal (last-write-wins).
      if (usuario) ops.push(r.hset(KEY_RAMAIS, { [ramal]: usuario }));
    }
    if (fonte) {
      const kf = keyDiaFonte(dia);
      ops.push(
        r.hincrby(kf, fieldFonte(fonte, model, params.op, "in"), inTok),
        r.hincrby(kf, fieldFonte(fonte, model, params.op, "out"), outTok),
        r.hincrby(kf, fieldFonte(fonte, model, params.op, "calls"), 1),
      );
      if (sec)
        ops.push(r.hincrby(kf, fieldFonte(fonte, model, params.op, "sec"), sec));
    }
    const itemId = String(params.itemId || "").trim();
    if (itemId) {
      const ki = keyItem(itemId);
      ops.push(
        r.hincrby(ki, field(model, params.op, "in"), inTok),
        r.hincrby(ki, field(model, params.op, "out"), outTok),
        r.hincrby(ki, field(model, params.op, "calls"), 1),
      );
      if (sec) ops.push(r.hincrby(ki, field(model, params.op, "sec"), sec));
      ops.push(r.expire(ki, ITEM_TTL_SEG));
    }
    await Promise.all(ops);
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
  audioSec: number;
}

// Uso acumulado de um atendimento (todas as chamadas de IA daquele id).
// Devolve lista vazia se o item nao tem registro (ex.: preview veio do cache,
// ou o uso foi gravado antes deste recurso existir).
export async function getUsoDoItem(itemId: string): Promise<UsoLinha[]> {
  const r = getRedis();
  const id = String(itemId || "").trim();
  if (!r || !id) return [];
  try {
    const hash =
      (await r.hgetall<Record<string, string | number>>(keyItem(id))) || {};
    const m = new Map<string, UsoLinha>();
    for (const [rawField, rawValue] of Object.entries(hash)) {
      const parts = rawField.split("::");
      if (parts.length !== 3) continue;
      const [model, op, metric] = parts;
      const value = Number(rawValue) || 0;
      const chave = `${model}::${op}`;
      const linha =
        m.get(chave) ||
        ({
          model,
          op: op as Operacao,
          inputTokens: 0,
          outputTokens: 0,
          calls: 0,
          audioSec: 0,
        } as UsoLinha);
      if (metric === "in") linha.inputTokens += value;
      else if (metric === "out") linha.outputTokens += value;
      else if (metric === "calls") linha.calls += value;
      else if (metric === "sec") linha.audioSec += value;
      m.set(chave, linha);
    }
    return Array.from(m.values());
  } catch (error) {
    console.warn("[usage] falha ao ler uso do item:", getErrorMessage(error));
    return [];
  }
}

export interface UsoPorDia {
  dia: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  audioSec: number;
}

// Detalhe cru por dia + modelo + operacao (para custo por dia, tabela, ranking).
export interface UsoPorDiaModelo {
  dia: string;
  model: string;
  op: Operacao;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  audioSec: number;
}

// Detalhe cru por dia + ramal + modelo + operacao (para gasto por ramal/usuario).
export interface UsoPorRamal {
  dia: string;
  ramal: string;
  usuario: string;
  model: string;
  op: Operacao;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  audioSec: number;
}

// Detalhe cru por dia + fonte (ligacao/email) + modelo + operacao.
export interface UsoPorFonte {
  dia: string;
  fonte: string;
  model: string;
  op: Operacao;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  audioSec: number;
}

export interface RelatorioUso {
  linhas: UsoLinha[]; // agregado por modelo+operacao (todo o periodo)
  porDia: UsoPorDia[]; // agregado por dia (totais)
  porDiaModelo: UsoPorDiaModelo[]; // detalhe por dia+modelo+op (cru, sem preco)
  porRamal: UsoPorRamal[]; // detalhe por dia+ramal+modelo+op (cru, sem preco)
  porFonte: UsoPorFonte[]; // detalhe por dia+fonte+modelo+op (cru, sem preco)
  configurado: boolean;
}

// Ramal -> nome do usuario, como o app manda junto do uso de IA. A aba
// "Online" do /admin usa para dar nome a quem esta conectado. 1 comando.
export async function lerNomesDosRamais(): Promise<Record<string, string>> {
  const r = getRedis();
  if (!r) return {};
  const hash = (await r.hgetall<Record<string, unknown>>(KEY_RAMAIS)) || {};
  const nomes: Record<string, string> = {};
  for (const [ramal, nome] of Object.entries(hash)) {
    if (nome != null && String(nome).trim()) nomes[ramal] = String(nome).trim();
  }
  return nomes;
}

// Le e agrega todo o uso registrado.
export async function getRelatorioUso(): Promise<RelatorioUso> {
  const r = getRedis();
  if (!r) {
    return {
      linhas: [],
      porDia: [],
      porDiaModelo: [],
      porRamal: [],
      porFonte: [],
      configurado: false,
    };
  }

  const dias = ((await r.smembers(KEY_DIAS)) || []).sort();
  const nomesRamais =
    (await r.hgetall<Record<string, string>>(KEY_RAMAIS)) || {};

  const agg = new Map<string, UsoLinha>();
  const porDia: UsoPorDia[] = [];
  const porDiaModelo: UsoPorDiaModelo[] = [];
  const porRamal: UsoPorRamal[] = [];
  const porFonte: UsoPorFonte[] = [];

  for (const dia of dias) {
    // --- Totais e detalhe por modelo+op do dia (uso:d:<dia>) ---
    const hash =
      (await r.hgetall<Record<string, string | number>>(keyDia(dia))) || {};
    const doDia = new Map<string, UsoPorDiaModelo>();
    let diaIn = 0;
    let diaOut = 0;
    let diaCalls = 0;
    let diaSec = 0;

    for (const [rawField, rawValue] of Object.entries(hash)) {
      const parts = rawField.split("::");
      if (parts.length !== 3) continue;
      const [model, op, metric] = parts;
      const value = Number(rawValue) || 0;

      const chave = `${model}::${op}`;
      const linha =
        agg.get(chave) ||
        ({
          model,
          op: op as Operacao,
          inputTokens: 0,
          outputTokens: 0,
          calls: 0,
          audioSec: 0,
        } as UsoLinha);
      const item =
        doDia.get(chave) ||
        ({
          dia,
          model,
          op: op as Operacao,
          inputTokens: 0,
          outputTokens: 0,
          calls: 0,
          audioSec: 0,
        } as UsoPorDiaModelo);

      if (metric === "in") {
        linha.inputTokens += value;
        item.inputTokens += value;
        diaIn += value;
      } else if (metric === "out") {
        linha.outputTokens += value;
        item.outputTokens += value;
        diaOut += value;
      } else if (metric === "calls") {
        linha.calls += value;
        item.calls += value;
        diaCalls += value;
      } else if (metric === "sec") {
        linha.audioSec += value;
        item.audioSec += value;
        diaSec += value;
      }
      agg.set(chave, linha);
      doDia.set(chave, item);
    }

    porDia.push({
      dia,
      inputTokens: diaIn,
      outputTokens: diaOut,
      calls: diaCalls,
      audioSec: diaSec,
    });
    for (const it of doDia.values()) porDiaModelo.push(it);

    // --- Detalhe por ramal do dia (uso:du:<dia>) ---
    const hashU =
      (await r.hgetall<Record<string, string | number>>(keyDiaUser(dia))) || {};
    const doDiaRamal = new Map<string, UsoPorRamal>();

    for (const [rawField, rawValue] of Object.entries(hashU)) {
      const parts = rawField.split("::");
      if (parts.length !== 4) continue;
      const [model, op, ramal, metric] = parts;
      const value = Number(rawValue) || 0;

      const chave = `${ramal}::${model}::${op}`;
      const item =
        doDiaRamal.get(chave) ||
        ({
          dia,
          ramal,
          usuario: nomesRamais[ramal] || "",
          model,
          op: op as Operacao,
          inputTokens: 0,
          outputTokens: 0,
          calls: 0,
          audioSec: 0,
        } as UsoPorRamal);

      if (metric === "in") item.inputTokens += value;
      else if (metric === "out") item.outputTokens += value;
      else if (metric === "calls") item.calls += value;
      else if (metric === "sec") item.audioSec += value;
      doDiaRamal.set(chave, item);
    }
    for (const it of doDiaRamal.values()) porRamal.push(it);

    // --- Detalhe por fonte do dia (uso:df:<dia>) ---
    const hashF =
      (await r.hgetall<Record<string, string | number>>(keyDiaFonte(dia))) || {};
    const doDiaFonte = new Map<string, UsoPorFonte>();

    for (const [rawField, rawValue] of Object.entries(hashF)) {
      const parts = rawField.split("::");
      if (parts.length !== 4) continue;
      const [fonte, model, op, metric] = parts;
      const value = Number(rawValue) || 0;

      const chave = `${fonte}::${model}::${op}`;
      const item =
        doDiaFonte.get(chave) ||
        ({
          dia,
          fonte,
          model,
          op: op as Operacao,
          inputTokens: 0,
          outputTokens: 0,
          calls: 0,
          audioSec: 0,
        } as UsoPorFonte);

      if (metric === "in") item.inputTokens += value;
      else if (metric === "out") item.outputTokens += value;
      else if (metric === "calls") item.calls += value;
      else if (metric === "sec") item.audioSec += value;
      doDiaFonte.set(chave, item);
    }
    for (const it of doDiaFonte.values()) porFonte.push(it);
  }

  await somarGastoDaTriagem(agg, porDia, porDiaModelo, porFonte);

  return {
    linhas: Array.from(agg.values()),
    porDia,
    porDiaModelo,
    porRamal,
    porFonte,
    configurado: true,
  };
}

// A triagem de e-mail grava o gasto no Supabase desde 12/11/2026
// (triagemPiloto.ts): no uso:* do Redis eram 6 comandos por conferencia, e o
// gratuito do Upstash nao aguentaria todo mundo no piloto. O que ela gravou
// antes continua no Redis e ja entrou acima; cada conferencia grava num lugar
// so, entao somar nao conta duas vezes. Entra no total, por dia, por modelo e
// na fonte "triagem" (sem ramal, como antes).
async function somarGastoDaTriagem(
  agg: Map<string, UsoLinha>,
  porDia: UsoPorDia[],
  porDiaModelo: UsoPorDiaModelo[],
  porFonte: UsoPorFonte[],
): Promise<void> {
  let usos;
  try {
    usos = await bancoDaTriagem().lerUso();
  } catch (error) {
    // O resto do custo continua no painel, mas sem a triagem o total sai a
    // menos: fica no log e no /admin/erros.
    const mensagem = `gasto da triagem fora do painel de custos: ${getErrorMessage(error)}`;
    console.error(`[usage] ${mensagem}`);
    await registrarErro({
      ts: new Date().toISOString(),
      origem: "backend",
      tipo: "erro",
      mensagem,
      contexto: "admin:uso",
    }).catch((e) => console.error("[usage] nem o registro do erro foi:", getErrorMessage(e)));
    return;
  }
  const zerado = { inputTokens: 0, outputTokens: 0, calls: 0, audioSec: 0 };
  for (const u of usos) {
    const op = u.op as Operacao;
    const somar = (alvo: { inputTokens: number; outputTokens: number; calls: number }) => {
      alvo.inputTokens += u.inputTokens;
      alvo.outputTokens += u.outputTokens;
      alvo.calls += u.chamadas;
    };
    const chave = `${u.modelo}::${op}`;
    const linha = agg.get(chave) || { model: u.modelo, op, ...zerado };
    somar(linha);
    agg.set(chave, linha);

    let dia = porDia.find((d) => d.dia === u.dia);
    if (!dia) porDia.push((dia = { dia: u.dia, ...zerado }));
    somar(dia);

    let dm = porDiaModelo.find((d) => d.dia === u.dia && d.model === u.modelo && d.op === op);
    if (!dm) porDiaModelo.push((dm = { dia: u.dia, model: u.modelo, op, ...zerado }));
    somar(dm);

    let df = porFonte.find(
      (d) => d.dia === u.dia && d.fonte === "triagem" && d.model === u.modelo && d.op === op,
    );
    if (!df) porFonte.push((df = { dia: u.dia, fonte: "triagem", model: u.modelo, op, ...zerado }));
    somar(df);
  }
  porDia.sort((a, b) => a.dia.localeCompare(b.dia));
}
