import { Redis } from "@upstash/redis";
import { getErrorMessage } from "../lib/errors";
import { getUsoDoItem } from "./usage";
import { custoLinha } from "./pricing";
import { buscarClientePorId, buscarTipos } from "./suite360";

// Custo de IA por CHAMADO criado — o que permite responder "quanto custou
// atender o cliente X" e "qual assunto consome mais IA".
//
// Como funciona: o uso de IA e acumulado por atendimento (`uso:item:<id>` em
// usage.ts). Quando o chamado e criado de verdade, este servico le aquele
// acumulado, precifica e guarda UMA linha com cliente/assunto. E forward-only:
// so vale para chamados criados a partir de agora.
//
// Privacidade: guarda nome do CLIENTE (pessoa juridica atendida) e o assunto —
// dado de negocio, exibido so no painel admin. Nunca guarda transcricao,
// resumo, telefone ou conteudo do e-mail.

let redis: Redis | null = null;
function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

const KEY = "uso:chamados";
// Teto da lista de chamados (rolling: entra um, sai o mais antigo).
// Dimensionado contra o PIOR caso: ~4 mil chamados/mes no Suite360 inteiro.
// Como o painel so olha 2 meses (ver LIMITE_MESES no admin.controller), o
// necessario e ~8 mil — 10 mil deixa ~25% de folga. Custo: ~3 MB no Redis.
// Se os chamados criados PELO APP passarem de ~5 mil/mes, revisar este numero.
const MAX = 10000;
let mem: string[] = [];

export interface ChamadoCusto {
  ts: string;
  dia: string; // YYYY-MM-DD (UTC), igual as chaves do painel
  fonte: string; // "ligacao" | "email" | "chat"
  itemId: string;
  clienteId: string;
  cliente: string;
  assuntoId: string;
  assunto: string;
  ramal?: string;
  usuario?: string;
  protocolo?: string;
  inputTokens: number;
  outputTokens: number;
  audioSec: number;
  calls: number;
  custoUsd: number;
}

// Nome do cliente/assunto para a tabela do painel. O app pode mandar os nomes
// prontos (ele ja os exibe no modal); quando nao manda, resolve no Suite —
// best-effort, porque isto e telemetria e nao pode atrasar/derrubar a criacao.
async function resolverNomes(params: {
  clienteId?: string;
  cliente?: string;
  assuntoId?: string;
  assunto?: string;
}): Promise<{ cliente: string; assunto: string }> {
  let cliente = String(params.cliente || "").trim();
  let assunto = String(params.assunto || "").trim();

  if (!cliente && params.clienteId) {
    const c = await buscarClientePorId(params.clienteId).catch(() => null);
    cliente = c?.razao_social || "";
  }
  if (!assunto && params.assuntoId) {
    const tipos = await buscarTipos().catch(() => []);
    assunto = tipos.find((t) => t.id === params.assuntoId)?.nome || "";
  }
  return { cliente, assunto };
}

export async function registrarCustoChamado(params: {
  itemId: string;
  fonte: string;
  clienteId?: string;
  cliente?: string;
  assuntoId?: string;
  assunto?: string;
  ramal?: string;
  usuario?: string;
  protocolo?: string;
}): Promise<void> {
  try {
    const linhas = await getUsoDoItem(params.itemId);
    // Sem uso registrado nao ha custo a atribuir (ex.: preview servido do
    // cache, ou chamado criado sem passar pela IA). Nao inventa linha zerada.
    if (!linhas.length) return;

    const total = linhas.reduce(
      (acc, l) => {
        acc.inputTokens += l.inputTokens;
        acc.outputTokens += l.outputTokens;
        acc.audioSec += l.audioSec;
        acc.calls += l.calls;
        acc.custoUsd += custoLinha(
          l.model,
          l.inputTokens,
          l.outputTokens,
          l.audioSec,
        );
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, audioSec: 0, calls: 0, custoUsd: 0 },
    );

    const nomes = await resolverNomes(params);
    const agora = new Date();
    const entry: ChamadoCusto = {
      ts: agora.toISOString(),
      dia: agora.toISOString().slice(0, 10),
      fonte: params.fonte || "ligacao",
      itemId: params.itemId,
      clienteId: String(params.clienteId || ""),
      cliente: nomes.cliente.slice(0, 160),
      assuntoId: String(params.assuntoId || ""),
      assunto: nomes.assunto.slice(0, 160),
      ramal: params.ramal || undefined,
      usuario: params.usuario || undefined,
      protocolo: params.protocolo || undefined,
      ...total,
    };

    const json = JSON.stringify(entry);
    const r = getRedis();
    if (r) {
      await r.lpush(KEY, json);
      await r.ltrim(KEY, 0, MAX - 1);
      return;
    }
    mem.unshift(json);
    mem = mem.slice(0, MAX);
  } catch (error) {
    // Telemetria de custo jamais derruba a criacao do chamado.
    console.warn(
      "[custoChamados] falha ao registrar custo do chamado:",
      getErrorMessage(error),
    );
  }
}

export async function listarCustoChamados(
  limit = MAX,
): Promise<ChamadoCusto[]> {
  const r = getRedis();
  const raw = r
    ? (await r.lrange<string>(KEY, 0, limit - 1)) || []
    : mem.slice(0, limit);
  return raw
    .map((item) => {
      try {
        return typeof item === "string" ? JSON.parse(item) : item;
      } catch {
        return null;
      }
    })
    .filter((e): e is ChamadoCusto => e !== null);
}
