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

// ---- Tokens do Gmail: POR USUARIO (chaveados pelo e-mail) ----
export async function saveGmailRefresh(email: string, t: string) {
  await setValue(`gmail:refresh:${email}`, t);
}
export async function getGmailRefresh(email: string) {
  return getValue(`gmail:refresh:${email}`);
}
export async function saveGmailAccess(
  email: string,
  t: string,
  ttlSeconds: number,
) {
  await setValue(`gmail:access:${email}`, t, Math.max(30, ttlSeconds - 60));
}
export async function getGmailAccess(email: string) {
  return getValue(`gmail:access:${email}`);
}

// Token opaco de perfil -> e-mail do usuario. O app guarda o token (nao o e-mail)
// e o envia nas chamadas; o backend resolve o e-mail a partir dele.
export async function setPerfilToken(token: string, email: string) {
  await setValue(`gmail:profile:${token}`, email);
}
export async function getEmailByToken(token: string) {
  return getValue(`gmail:profile:${token}`);
}

// Mapa messageId -> conta (e-mail). Guardado no preview para o criar saber de qual
// conta remover o marcador depois. TTL de 6h (preview e criar sao quase imediatos).
export async function salvarContaDoEmail(messageId: string, email: string) {
  await salvarContaDoItem(messageId, email, "gmail");
}
export async function getContaDoEmail(messageId: string) {
  return getContaDoItem(messageId, "gmail");
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

// ---- Idempotencia da CRIACAO do chamado (produção) ----
// Registro do chamado ja criado (protocolo) para nao criar duplicado.
// O `ns` (namespace) permite reusar a mesma idempotencia para outras fontes:
// "goto" (padrao) para ligacoes; "gmail" para e-mails (chave = messageId).
export async function getChamadoCriado(
  id: string,
  ns = "goto",
): Promise<{ id: string; protocolo: string } | null> {
  const raw = (await getValue(`${ns}:chamado:${id}`)) as unknown;
  if (!raw) return null;
  if (typeof raw === "object") return raw as { id: string; protocolo: string };
  try {
    return JSON.parse(raw as string);
  } catch {
    return null;
  }
}
export async function salvarChamadoCriado(
  id: string,
  dados: { id: string; protocolo: string },
  ns = "goto",
  ttlSeg = 30 * 24 * 3600, // 30 dias (producao). Dry-run passa um TTL curto.
) {
  await setValue(`${ns}:chamado:${id}`, JSON.stringify(dados), ttlSeg);
}
// ---- Cache do PREVIEW (transcricao + resumo da IA) ----
// Evita REPROCESSAR (re-baixar a gravacao, re-transcrever e re-resumir) uma
// ligacao ja processada quando o atendente reabre o preview sem ter criado o
// chamado. Chaveado SO por conversationSpaceId: transcript/resumo dependem so da
// gravacao, nao de quem clicou (cliente/setor/executor sao recomputados sempre).
// TTL curto (cobre reabrir no mesmo dia/semana); some sozinho depois.
const PREVIEW_CACHE_TTL_SEG =
  Number(process.env.PREVIEW_CACHE_TTL_SEG) || 48 * 3600; // 48h

export interface PreviewCacheDados {
  transcript: string;
  resumo: unknown; // ResumoJson (evita dependencia circular com o controller)
  iaOk: boolean;
  gravacaoNota: string;
}

export async function getPreviewCache(
  conversationSpaceId: string,
): Promise<PreviewCacheDados | null> {
  if (!conversationSpaceId) return null;
  const raw = (await getValue(
    `goto:previewcache:${conversationSpaceId}`,
  )) as unknown;
  if (!raw) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (obj && typeof (obj as PreviewCacheDados).transcript === "string") {
    return obj as PreviewCacheDados;
  }
  return null;
}
export async function salvarPreviewCache(
  conversationSpaceId: string,
  dados: PreviewCacheDados,
) {
  if (!conversationSpaceId) return;
  await setValue(
    `goto:previewcache:${conversationSpaceId}`,
    JSON.stringify(dados),
    PREVIEW_CACHE_TTL_SEG,
  );
}

// Lock atomico (SET NX) para impedir criacao concorrente do mesmo item.
// Retorna true se conseguiu reservar (deve criar); false se ja ha uma em andamento.
export async function reservarCriacao(
  id: string,
  ns = "goto",
): Promise<boolean> {
  const key = `${ns}:criando:${id}`;
  const r = getRedis();
  if (r) {
    const res = await r.set(key, "1", { nx: true, ex: 120 });
    return res === "OK";
  }
  if (memGet(key)) return false;
  mem.set(key, "1");
  memExpiry.set(key, Date.now() + 120_000);
  return true;
}
export async function liberarCriacao(id: string, ns = "goto") {
  const key = `${ns}:criando:${id}`;
  const r = getRedis();
  if (r) {
    await r.del(key);
    return;
  }
  mem.delete(key);
  memExpiry.delete(key);
}

// Lock do PREVIEW (transcricao+IA): impede que dois atendentes DIFERENTES rodem a
// IA para a mesma chamada ao mesmo tempo (custo dobrado). Escopado por `dono` (o
// ramal de quem clicou): o MESMO atendente pode reabrir/re-tentar sem travar; so
// bloqueia quando outro atendente ja esta processando. TTL curto, auto-expira.
export async function reservarPreview(
  id: string,
  ns = "goto",
  dono = "",
): Promise<boolean> {
  const key = `${ns}:preview:${id}`;
  const val = dono || "1";
  const r = getRedis();
  if (r) {
    const atual = await r.get(key);
    if (atual && String(atual) !== val) return false; // outro atendente processando
    await r.set(key, val, { ex: 300 });
    return true;
  }
  const atualMem = memGet(key);
  if (atualMem && atualMem !== val) return false;
  mem.set(key, val);
  memExpiry.set(key, Date.now() + 300_000);
  return true;
}
export async function liberarPreview(id: string, ns = "goto") {
  const key = `${ns}:preview:${id}`;
  const r = getRedis();
  if (r) {
    await r.del(key);
    return;
  }
  mem.delete(key);
  memExpiry.delete(key);
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

// ---------------------------------------------------------------------------
// Google Chat: escopos, cache generico, marca de "chamado gerado" e primitivas
// atomicas usadas pela fila por espaco (chatRateLimit.ts).
// ---------------------------------------------------------------------------

// ---- Escopos OAuth concedidos por conta Google ----
// Gravado no exchange/refresh do token (fonte da verdade) e, para contas antigas
// conectadas antes do Chat existir, preenchido pelo tokeninfo. Sem isto o app so
// descobriria que falta escopo levando 403 do Google no meio da tela.
export async function saveGoogleScopes(
  email: string,
  scopes: string,
  ttlSeg = 30 * 24 * 3600,
) {
  await setValue(`google:scopes:${email}`, scopes, ttlSeg);
}
export async function getGoogleScopes(email: string) {
  return getValue(`google:scopes:${email}`);
}
export async function limparGoogleScopes(email: string) {
  await delValue(`google:scopes:${email}`);
}

// ---- Cache JSON generico (usado pelo chatApi: espacos, membros, paginas) ----
export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = (await getValue(key)) as unknown;
  if (raw === null || raw === undefined) return null;
  // O cliente do Upstash ja devolve objeto quando o valor e JSON.
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(raw as string) as T;
  } catch {
    return null;
  }
}
export async function cacheSet(key: string, valor: unknown, ttlSeg: number) {
  if (ttlSeg <= 0) return; // TTL 0 = cache desligado (ex.: CHAT_MSG_CACHE_TTL_SEG=0)
  await setValue(key, JSON.stringify(valor), ttlSeg);
}
export async function cacheDel(key: string) {
  await delValue(key);
}

// ---- Mapa item -> conta (e-mail), com namespace ----
// Guardado no preview para o "criar" saber de qual conta veio o item.
export async function salvarContaDoItem(
  chave: string,
  email: string,
  ns = "gmail",
) {
  await setValue(`${ns}:acct:${chave}`, email, 6 * 3600);
}
export async function getContaDoItem(chave: string, ns = "gmail") {
  return getValue(`${ns}:acct:${chave}`);
}

// ---- Selecao de mensagens do preview (para o "criar" marcar como feitas) ----
export async function salvarSelecaoChat(chave: string, messageIds: string[]) {
  await setValue(`chat:sel:${chave}`, JSON.stringify(messageIds), 6 * 3600);
}
export async function getSelecaoChat(chave: string): Promise<string[]> {
  const lista = await cacheGet<string[]>(`chat:sel:${chave}`);
  return Array.isArray(lista) ? lista : [];
}

// ---- Marca "chamado ja gerado" por mensagem do Chat ----
// Substitui o "remover marcador" do Gmail (a Chat API nao tem write de leitura).
// HASH messageId -> protocolo, por espaco. Vantagem sobre o localStorage do
// e-mail: e COMPARTILHADO — se um colega ja abriu chamado daquelas mensagens,
// todo mundo ve o "check".
const CHAT_FEITO_TTL_SEG =
  (Number(process.env.CHAT_FEITO_TTL_DIAS) || 90) * 24 * 3600;

export async function marcarChatFeito(
  spaceId: string,
  messageIds: string[],
  protocolo: string,
): Promise<void> {
  if (!spaceId || !messageIds?.length) return;
  const key = `chat:feito:${spaceId}`;
  const campos: Record<string, string> = {};
  for (const id of messageIds) if (id) campos[id] = protocolo || "1";
  if (!Object.keys(campos).length) return;
  const r = getRedis();
  if (r) {
    await r.hset(key, campos);
    await r.expire(key, CHAT_FEITO_TTL_SEG);
    return;
  }
  const atual = (await cacheGet<Record<string, string>>(key)) || {};
  await cacheSet(key, { ...atual, ...campos }, CHAT_FEITO_TTL_SEG);
}

export async function getChatFeitos(
  spaceId: string,
): Promise<Record<string, string>> {
  if (!spaceId) return {};
  const key = `chat:feito:${spaceId}`;
  const r = getRedis();
  if (r) {
    const mapa = await r.hgetall<Record<string, string>>(key);
    return mapa || {};
  }
  return (await cacheGet<Record<string, string>>(key)) || {};
}

// ---- Primitivas atomicas para a fila por espaco (chatRateLimit.ts) ----
// Precisam ser ATOMICAS e COMPARTILHADAS: na Vercel cada instancia serverless
// enxerga so a si mesma, entao contador em memoria de processo nao limita nada.
export async function incrComTtl(key: string, ttlSeg: number): Promise<number> {
  const r = getRedis();
  if (r) {
    const n = await r.incr(key);
    if (n === 1) await r.expire(key, ttlSeg);
    return n;
  }
  const n = Number(memGet(key) || 0) + 1;
  mem.set(key, String(n));
  if (n === 1) memExpiry.set(key, Date.now() + ttlSeg * 1000);
  return n;
}

// SET NX: true se ESTE chamador criou a chave (ganhou o lock).
export async function setSeNaoExiste(
  key: string,
  valor: string,
  ttlSeg: number,
): Promise<boolean> {
  const r = getRedis();
  if (r) {
    const res = await r.set(key, valor, { nx: true, ex: ttlSeg });
    return res === "OK";
  }
  if (memGet(key)) return false;
  mem.set(key, valor);
  memExpiry.set(key, Date.now() + ttlSeg * 1000);
  return true;
}

export async function delValue(key: string): Promise<void> {
  const r = getRedis();
  if (r) {
    await r.del(key);
    return;
  }
  mem.delete(key);
  memExpiry.delete(key);
}
