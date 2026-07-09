import { Redis } from "@upstash/redis";

// Storage para a integracao GoTo. Em producao (Vercel, stateless) usa Upstash
// Redis (Vercel KV). Se as vars do Upstash nao estiverem definidas, cai para um
// storage EM MEMORIA (util em dev local; NAO persiste entre invocacoes serverless).

export interface CallEndedEvent {
  id: string;
  conversationSpaceId: string;
  direction?: string;
  from?: string;
  to?: string;
  endedAt: string;
  receivedAt: string;
  // Info de exibicao (montada a partir do relatorio):
  tipo?: "externo" | "interno";
  contatoNumero?: string; // externo: numero de quem ligou/foi ligado
  contatoRamal?: string; // interno: ramal do outro participante
  contatoNome?: string; // interno: nome do outro participante
}

const KEY = {
  refreshToken: "goto:refresh_token",
  accessToken: "goto:access_token",
  channelId: "goto:channel_id",
  accountKey: "goto:account_key",
  events: "goto:events",
};

let redis: Redis | null = null;
function getRedis(): Redis | null {
  // Aceita tanto os nomes do Upstash quanto os da integracao KV da Vercel.
  const url =
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

// ---- Fallback em memoria ----
const mem = new Map<string, string>();
let memEvents: CallEndedEvent[] = [];
const memExpiry = new Map<string, number>();

function memGet(key: string): string | null {
  const exp = memExpiry.get(key);
  if (exp && Date.now() > exp) {
    mem.delete(key);
    memExpiry.delete(key);
    return null;
  }
  return mem.get(key) ?? null;
}

export function isPersistentStore(): boolean {
  return getRedis() !== null;
}

async function setValue(key: string, value: string, ttlSeconds?: number) {
  const r = getRedis();
  if (r) {
    if (ttlSeconds) await r.set(key, value, { ex: ttlSeconds });
    else await r.set(key, value);
    return;
  }
  mem.set(key, value);
  if (ttlSeconds) memExpiry.set(key, Date.now() + ttlSeconds * 1000);
  else memExpiry.delete(key);
}

async function getValue(key: string): Promise<string | null> {
  const r = getRedis();
  if (r) return r.get<string>(key);
  return memGet(key);
}

export async function saveRefreshToken(t: string) {
  await setValue(KEY.refreshToken, t);
}
export async function getRefreshToken() {
  return getValue(KEY.refreshToken);
}

export async function saveAccessToken(t: string, ttlSeconds: number) {
  await setValue(KEY.accessToken, t, Math.max(30, ttlSeconds - 60));
}
export async function getAccessToken() {
  return getValue(KEY.accessToken);
}

export async function saveChannelId(id: string) {
  await setValue(KEY.channelId, id);
}
export async function getChannelId() {
  return getValue(KEY.channelId);
}

export async function saveAccountKey(k: string) {
  await setValue(KEY.accountKey, k);
}
export async function getAccountKey() {
  return getValue(KEY.accountKey);
}

// Flag de "chamado aberto" para uma chamada (usado no escalonamento interno):
// quando o caller abre o chamado, o answerer nao precisa mais ser notificado.
export async function marcarChamadoAberto(conversationSpaceId: string) {
  await setValue(`goto:aberto:${conversationSpaceId}`, "1", 900);
}
export async function chamadoFoiAberto(
  conversationSpaceId: string,
): Promise<boolean> {
  return (await getValue(`goto:aberto:${conversationSpaceId}`)) === "1";
}

export async function pushEvent(event: CallEndedEvent): Promise<void> {
  const r = getRedis();
  if (r) {
    await r.lpush(KEY.events, JSON.stringify(event));
    await r.ltrim(KEY.events, 0, 49);
    return;
  }
  memEvents.unshift(event);
  memEvents = memEvents.slice(0, 50);
}

// Drena (le e remove) os eventos pendentes, mais antigos primeiro.
export async function drainEvents(): Promise<CallEndedEvent[]> {
  const r = getRedis();
  if (r) {
    const raw = await r.lrange<string>(KEY.events, 0, -1);
    if (!raw || raw.length === 0) return [];
    await r.del(KEY.events);
    const parsed = raw
      .map((item) => {
        try {
          return typeof item === "string"
            ? (JSON.parse(item) as CallEndedEvent)
            : (item as CallEndedEvent);
        } catch {
          return null;
        }
      })
      .filter((e): e is CallEndedEvent => e !== null);
    return parsed.reverse();
  }

  const drained = memEvents.slice().reverse();
  memEvents = [];
  return drained;
}
