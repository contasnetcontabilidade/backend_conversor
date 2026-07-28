import { Redis } from "@upstash/redis";

// Erros do app desktop, para o suporte enxergar quebra na maquina do usuario
// sem depender de ele reclamar.
// Privacidade: NUNCA guarda transcricao, resumo, e-mail ou nome de cliente —
// so mensagem/stack do erro, versao, ramal/usuario e um rotulo de contexto.
// Mesmo padrao do feedback: lista capada no Redis, fallback em memoria (dev).

let redis: Redis | null = null;
function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

const KEY = "erros:list";
const MAX = 500; // guarda os ultimos 500 erros
let mem: string[] = [];

export interface ErroEntry {
  ts: string;
  origem: string; // "renderer" | "main" | outro rotulo curto
  tipo: string; // "erro" | "promise" | "crash"
  mensagem: string;
  stack?: string;
  contexto?: string; // aba/acao onde aconteceu (rotulo curto)
  versao?: string; // versao do app desktop
  ramal?: string;
  usuario?: string;
  plataforma?: string; // ex.: "win32 10.0.19045"
}

export async function registrarErro(entry: ErroEntry): Promise<void> {
  const json = JSON.stringify(entry);
  const r = getRedis();
  if (r) {
    await r.lpush(KEY, json);
    await r.ltrim(KEY, 0, MAX - 1);
    return;
  }
  mem.unshift(json);
  mem = mem.slice(0, MAX);
}

export async function listarErros(limit = 300): Promise<ErroEntry[]> {
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
    .filter((e): e is ErroEntry => e !== null);
}

export async function limparErros(): Promise<void> {
  const r = getRedis();
  if (r) {
    await r.del(KEY);
    return;
  }
  mem = [];
}
