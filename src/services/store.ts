import { Redis } from "@upstash/redis";
import { AppError } from "../lib/errors";

// Storage para a integracao GoTo (Vercel e stateless): guarda o refresh token,
// o access token (com TTL), o channelId do webhook e a fila de eventos que o
// app desktop consome por polling. Backend: Upstash Redis (Vercel KV).

let client: Redis | null = null;

function getRedis(): Redis {
  if (client) return client;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new AppError({
      statusCode: 503,
      code: "STORE_NOT_CONFIGURED",
      message:
        "Storage nao configurado. Defina UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN.",
    });
  }

  client = new Redis({ url, token });
  return client;
}

const KEY = {
  refreshToken: "goto:refresh_token",
  accessToken: "goto:access_token",
  channelId: "goto:channel_id",
  accountKey: "goto:account_key",
  events: "goto:events",
};

export async function saveRefreshToken(refreshToken: string): Promise<void> {
  await getRedis().set(KEY.refreshToken, refreshToken);
}

export async function getRefreshToken(): Promise<string | null> {
  return getRedis().get<string>(KEY.refreshToken);
}

export async function saveAccessToken(
  accessToken: string,
  ttlSeconds: number,
): Promise<void> {
  // Renova um pouco antes do vencimento real para evitar corrida na expiracao.
  const safeTtl = Math.max(30, ttlSeconds - 60);
  await getRedis().set(KEY.accessToken, accessToken, { ex: safeTtl });
}

export async function getAccessToken(): Promise<string | null> {
  return getRedis().get<string>(KEY.accessToken);
}

export async function saveChannelId(channelId: string): Promise<void> {
  await getRedis().set(KEY.channelId, channelId);
}

export async function getChannelId(): Promise<string | null> {
  return getRedis().get<string>(KEY.channelId);
}

export async function saveAccountKey(accountKey: string): Promise<void> {
  await getRedis().set(KEY.accountKey, accountKey);
}

export async function getAccountKey(): Promise<string | null> {
  return getRedis().get<string>(KEY.accountKey);
}

export interface CallEndedEvent {
  id: string;
  conversationSpaceId: string;
  direction?: string;
  from?: string;
  to?: string;
  endedAt: string;
  receivedAt: string;
}

export async function pushEvent(event: CallEndedEvent): Promise<void> {
  // Mantem a fila enxuta (ultimos 50 eventos).
  const redis = getRedis();
  await redis.lpush(KEY.events, JSON.stringify(event));
  await redis.ltrim(KEY.events, 0, 49);
}

// Drena (le e remove) todos os eventos pendentes, mais antigos primeiro.
export async function drainEvents(): Promise<CallEndedEvent[]> {
  const redis = getRedis();
  const raw = await redis.lrange<string>(KEY.events, 0, -1);
  if (!raw || raw.length === 0) return [];
  await redis.del(KEY.events);

  const parsed = raw
    .map((item) => {
      try {
        return typeof item === "string" ? (JSON.parse(item) as CallEndedEvent) : (item as CallEndedEvent);
      } catch {
        return null;
      }
    })
    .filter((e): e is CallEndedEvent => e !== null);

  // lpush coloca o mais novo no inicio; devolve em ordem cronologica.
  return parsed.reverse();
}
