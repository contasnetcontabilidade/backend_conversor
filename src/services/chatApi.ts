import { createHash } from "crypto";
import { AppError } from "../lib/errors";
import { getValidAccessToken, invalidarEscopos } from "./gmailAuth";
import { comSingleFlight, comVagaNoEspaco } from "./chatRateLimit";
import { cacheGet, cacheSet } from "./store";

// Cliente REST do Google Chat. Le as conversas que o usuario colocou na secao
// "Chamado" e as mensagens delas, para virarem chamado no Suite360.
//
// Espelha o gmailApi.ts de proposito: fetch puro (sem o pacote googleapis),
// tudo por usuario (e-mail) e reaproveitando o mesmo access token do Gmail.
//
// Decisao de arquitetura: leitura com auth de USUARIO (3LO), sem criar um Chat
// app/bot. A doc do Google e explicita: para chamadas somente-leitura com auth
// de usuario basta habilitar a API e ter o OAuth client. Com auth de usuario o
// criterio de acesso e a participacao do proprio usuario no espaco — a antiga
// limitacao de "so le espacos onde o bot foi adicionado" vale para app auth.

const CHAT_API = "https://chat.googleapis.com/v1";

// A secao personalizada e o analogo EXATO do marcador "Chamado" do Gmail: o
// usuario arrasta para la as conversas que viram chamado, e a aba mostra so essas.
function nomeSecao(): string {
  return (process.env.CHAT_SECAO || "Chamado").trim() || "Chamado";
}
function autocriarSecao(): boolean {
  return String(process.env.CHAT_SECAO_AUTOCRIAR ?? "1").trim() !== "0";
}
export function tamanhoPagina(): number {
  const n = Number(process.env.CHAT_PAGE_SIZE) || 100;
  return Math.min(Math.max(n, 10), 1000);
}
const CACHE_TTL_SEG = Number(process.env.CHAT_CACHE_TTL_SEG) || 12 * 3600;
const MSG_CACHE_TTL_SEG = Number(process.env.CHAT_MSG_CACHE_TTL_SEG ?? 120);

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

type Query = Record<string, string | number | undefined>;

function montarUrl(path: string, query?: Query): string {
  const url = new URL(`${CHAT_API}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

// Traduz o erro do Google para um codigo que o app sabe exibir. O 403 de escopo
// e separado do 403 comum: e a diferenca entre "reconecte sua conta" e "voce nao
// participa desse espaco", que exigem acoes opostas do usuario.
function erroDoChat(email: string, status: number, payload: unknown): AppError {
  const texto = JSON.stringify(payload || "");
  const escopoInsuficiente =
    status === 403 &&
    /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|request had insufficient/i.test(
      texto,
    );

  if (status === 401) {
    return new AppError({
      statusCode: 401,
      code: "CHAT_NOT_AUTHORIZED",
      message:
        "Sua conexao com o Google expirou. Reconecte em Configurar Perfil.",
      details: payload,
    });
  }
  if (escopoInsuficiente) {
    // O registro local de escopos esta velho (ex.: admin revogou). Zera para a
    // proxima consulta ir ao Google em vez de repetir a informacao errada.
    void invalidarEscopos(email).catch(() => undefined);
    return new AppError({
      statusCode: 403,
      code: "CHAT_SCOPE_MISSING",
      message:
        "Sua conta Google ainda nao liberou o acesso ao Chat. Reconecte em Configurar Perfil.",
      details: payload,
    });
  }
  if (status === 404) {
    return new AppError({
      statusCode: 404,
      code: "CHAT_SPACE_NOT_FOUND",
      message: "Esta conversa nao esta mais disponivel.",
      details: payload,
    });
  }
  if (status === 429) {
    return new AppError({
      statusCode: 429,
      code: "CHAT_RATE_LIMITED",
      message: "Muitas leituras do Chat agora. Tente de novo em instantes.",
      details: payload,
    });
  }
  return new AppError({
    statusCode: 502,
    code: "CHAT_API_ERROR",
    message: `Falha na API do Google Chat (HTTP ${status}).`,
    details: payload,
  });
}

function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// GET com backoff em 429. E a ultima linha de defesa da cota: a fila por espaco
// (chatRateLimit) segura o NOSSO consumo, mas outros apps compartilham a mesma
// cota por espaco e nao passam por ela.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function chatGet(
  email: string,
  path: string,
  query?: Query,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const url = montarUrl(path, query);
  let ultimoErro: AppError | null = null;

  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const token = await getValidAccessToken(email);
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const texto = await resp.text();
    let payload: unknown = null;
    try {
      payload = texto ? JSON.parse(texto) : null;
    } catch {
      payload = { raw: texto };
    }
    if (resp.ok) return payload;

    ultimoErro = erroDoChat(email, resp.status, payload);
    if (resp.status !== 429) throw ultimoErro;

    const retryAfter = Number(resp.headers.get("Retry-After"));
    const espera =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * Math.pow(2, tentativa); // 1s, 2s, 4s
    await dormir(espera);
  }
  throw ultimoErro as AppError;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function chatPost(
  email: string,
  path: string,
  body: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const token = await getValidAccessToken(email);
  const resp = await fetch(montarUrl(path), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const texto = await resp.text();
  let payload: unknown = null;
  try {
    payload = texto ? JSON.parse(texto) : null;
  } catch {
    payload = { raw: texto };
  }
  if (!resp.ok) throw erroDoChat(email, resp.status, payload);
  return payload;
}

// ---------------------------------------------------------------------------
// Tipos normalizados (o renderer nunca ve o formato cru do Google)
// ---------------------------------------------------------------------------

export interface EspacoResumo {
  id: string; // "spaces/AAAA" — resource name completo
  nome: string;
  tipo: "SPACE" | "GROUP_CHAT" | "DIRECT_MESSAGE";
}

export interface MensagemChat {
  id: string; // "spaces/X/messages/Y"
  spaceId: string;
  texto: string;
  autorId: string; // "users/123"
  autor: string; // displayName ja resolvido
  autorEhApp: boolean;
  hora: string; // createTime ISO
  threadName: string;
  editado: boolean;
  temAnexo: boolean;
}

export interface PaginaMensagens {
  mensagens: MensagemChat[];
  proximaPagina: string;
}

// ---------------------------------------------------------------------------
// Secao "Chamado" — o analogo do marcador do Gmail
// ---------------------------------------------------------------------------

// Garante que a secao existe (cria se faltar). Best-effort: NUNCA lanca, igual
// ao garantirMarcador do Gmail — falhar aqui nao pode impedir o login.
export async function garantirSecaoChamado(email: string): Promise<string> {
  const chaveCache = `chat:secao:${email}`;
  try {
    const cacheado = await cacheGet<string>(chaveCache);
    if (cacheado) return cacheado;

    const alvo = nomeSecao().toLowerCase();
    const lista = await chatGet(email, "/users/me/sections", { pageSize: 100 });
    const secoes: Array<{ name?: string; displayName?: string }> = Array.isArray(
      lista?.sections,
    )
      ? lista.sections
      : [];
    let id = String(
      secoes.find((s) => String(s.displayName || "").toLowerCase() === alvo)
        ?.name || "",
    );

    if (!id && autocriarSecao()) {
      try {
        const criada = await chatPost(email, "/users/me/sections", {
          displayName: nomeSecao(),
          type: "CUSTOM_SECTION",
        });
        id = String(criada?.name || "");
      } catch {
        // Corrida (outra janela criou ao mesmo tempo) ou limite: procura de novo.
        const relista = await chatGet(email, "/users/me/sections", {
          pageSize: 100,
        });
        const denovo: Array<{ name?: string; displayName?: string }> =
          Array.isArray(relista?.sections) ? relista.sections : [];
        id = String(
          denovo.find((s) => String(s.displayName || "").toLowerCase() === alvo)
            ?.name || "",
        );
      }
    }
    if (id) await cacheSet(chaveCache, id, 24 * 3600).catch(() => undefined);
    return id;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Espacos
// ---------------------------------------------------------------------------

function normalizarEspaco(bruto: {
  name?: string;
  displayName?: string;
  spaceType?: string;
  type?: string;
}): EspacoResumo {
  const tipo = (bruto.spaceType ||
    bruto.type ||
    "SPACE") as EspacoResumo["tipo"];
  // DM e grupo informal nao tem displayName; o nome sai dos membros (adiante).
  const nome =
    String(bruto.displayName || "").trim() ||
    (tipo === "DIRECT_MESSAGE" ? "Mensagem direta" : "Conversa");
  return { id: String(bruto.name || ""), nome, tipo };
}

async function detalharEspaco(
  email: string,
  spaceId: string,
): Promise<EspacoResumo> {
  const chaveCache = `chat:space:${spaceId}`;
  const cacheado = await cacheGet<EspacoResumo>(chaveCache).catch(() => null);
  if (cacheado) return cacheado;

  const bruto = await chatGet(email, `/${spaceId}`);
  const espaco = normalizarEspaco(bruto || {});
  // DM/grupo sem nome proprio: usa os participantes como rotulo, senao o usuario
  // veria uma lista de "Conversa, Conversa, Conversa".
  if (
    espaco.tipo !== "SPACE" &&
    /^(Conversa|Mensagem direta)$/.test(espaco.nome)
  ) {
    const ids = await membrosDoEspaco(email, spaceId).catch(() => [] as string[]);
    const nomes = Object.values(await resolverNomes(email, ids)).filter(Boolean);
    if (nomes.length) espaco.nome = nomes.slice(0, 3).join(", ");
  }
  await cacheSet(chaveCache, espaco, 24 * 3600).catch(() => undefined);
  return espaco;
}

// Conversas que o usuario colocou na secao "Chamado". E a lista padrao da aba:
// curta, escolhida por ele, e por isso rapida.
export async function listarEspacosDaSecao(
  email: string,
): Promise<EspacoResumo[]> {
  const secaoId = await garantirSecaoChamado(email);
  if (!secaoId) return [];
  const itens = await chatGet(email, `/${secaoId}/items`, { pageSize: 100 });
  const lista: Array<{ space?: string }> = Array.isArray(itens?.sectionItems)
    ? itens.sectionItems
    : [];
  const ids = lista.map((i) => String(i.space || "")).filter(Boolean);
  const espacos = await Promise.all(
    ids.map((id) => detalharEspaco(email, id).catch(() => null)),
  );
  return espacos.filter((e): e is EspacoResumo => e !== null);
}

// Todas as conversas do usuario (a saida "Ver todas as conversas" da aba, para
// quem ainda nao organizou nada na secao).
export async function listarEspacos(
  email: string,
  opts: {
    pageSize?: number;
    pageToken?: string;
    tipo?: "salas" | "diretas" | "todos";
  } = {},
): Promise<{ espacos: EspacoResumo[]; proximaPagina: string }> {
  const filtro =
    opts.tipo === "salas"
      ? 'spaceType = "SPACE"'
      : opts.tipo === "diretas"
        ? 'spaceType = "GROUP_CHAT" OR spaceType = "DIRECT_MESSAGE"'
        : undefined;
  const data = await chatGet(email, "/spaces", {
    pageSize: Math.min(opts.pageSize || 100, 1000),
    pageToken: opts.pageToken,
    filter: filtro,
  });
  const brutos: Array<Record<string, string>> = Array.isArray(data?.spaces)
    ? data.spaces
    : [];
  const espacos = await Promise.all(
    brutos.map(async (b) => {
      const e = normalizarEspaco(b);
      if (e.tipo === "SPACE" || !e.id) return e;
      return detalharEspaco(email, e.id).catch(() => e);
    }),
  );
  return { espacos, proximaPagina: String(data?.nextPageToken || "") };
}

// ---------------------------------------------------------------------------
// Nomes das pessoas — via People API
// ---------------------------------------------------------------------------
//
// A Chat API NAO devolve o nome de ninguem quando a autenticacao e de usuario:
// tanto message.sender quanto membership.member vem so como { name, type }, ou
// seja, "users/107151570842704851146". A doc do Google e explicita sobre isso e
// aponta a People API como a forma de resolver: users/123 no Chat corresponde a
// people/123 na People API.
//
// Sem esta etapa o chamado sairia com "Participante 1146" no lugar do nome do
// colega — inutil para quem for ler o chamado depois.

const PEOPLE_API = "https://people.googleapis.com/v1";
const NOME_TTL_SEG = 7 * 24 * 3600; // nome de pessoa muda raramente
const PEOPLE_LOTE = 200; // teto do batchGet

// Ids dos membros de um espaco (so os ids; nomes vem da People API).
async function membrosDoEspaco(
  email: string,
  spaceId: string,
): Promise<string[]> {
  const chaveCache = `chat:membros:${spaceId}`;
  const cacheado = await cacheGet<string[]>(chaveCache).catch(() => null);
  if (Array.isArray(cacheado)) return cacheado;

  const data = await chatGet(email, `/${spaceId}/members`, {
    pageSize: 1000,
    showGroups: "false",
  });
  const membros: Array<{ member?: { name?: string; type?: string } }> =
    Array.isArray(data?.memberships) ? data.memberships : [];
  const ids = membros
    .filter((m) => String(m?.member?.type || "") !== "BOT")
    .map((m) => String(m?.member?.name || ""))
    .filter(Boolean);
  await cacheSet(chaveCache, ids, CACHE_TTL_SEG).catch(() => undefined);
  return ids;
}

// userId ("users/123") -> nome. Cache por PESSOA, nao por espaco: a mesma pessoa
// aparece em varias conversas, entao o cache aquece rapido e o custo tende a zero.
export async function resolverNomes(
  email: string,
  userIds: string[],
): Promise<Record<string, string>> {
  const unicos = [...new Set(userIds.filter(Boolean))];
  const mapa: Record<string, string> = {};
  const faltando: string[] = [];

  for (const id of unicos) {
    const nome = await cacheGet<string>(`chat:nome:${id}`).catch(() => null);
    if (nome) mapa[id] = nome;
    else faltando.push(id);
  }
  if (!faltando.length) return mapa;

  const token = await getValidAccessToken(email).catch(() => "");
  if (!token) return mapa;

  for (let i = 0; i < faltando.length; i += PEOPLE_LOTE) {
    const lote = faltando.slice(i, i + PEOPLE_LOTE);
    const url = new URL(`${PEOPLE_API}/people:batchGet`);
    for (const id of lote) {
      // users/123 (Chat) -> people/123 (People API)
      url.searchParams.append("resourceNames", id.replace(/^users\//, "people/"));
    }
    url.searchParams.set("personFields", "names,emailAddresses");
    // Sem DOMAIN_PROFILE os colegas do Workspace nao sao encontrados — e sao
    // justamente eles que aparecem no Chat interno.
    url.searchParams.append("sources", "READ_SOURCE_TYPE_PROFILE");
    url.searchParams.append("sources", "READ_SOURCE_TYPE_DOMAIN_PROFILE");

    try {
      const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!resp.ok) continue; // best-effort: cai no fallback de nome
      const data = (await resp.json()) as {
        responses?: Array<{
          requestedResourceName?: string;
          person?: {
            names?: Array<{ displayName?: string }>;
            emailAddresses?: Array<{ value?: string }>;
          };
        }>;
      };
      for (const r of data.responses || []) {
        const pid = String(r.requestedResourceName || "").replace(
          /^people\//,
          "users/",
        );
        const nome =
          String(r.person?.names?.[0]?.displayName || "").trim() ||
          // Sem nome no perfil, o e-mail ainda identifica melhor que um id.
          String(r.person?.emailAddresses?.[0]?.value || "")
            .split("@")[0]
            .trim();
        if (pid && nome) {
          mapa[pid] = nome;
          await cacheSet(`chat:nome:${pid}`, nome, NOME_TTL_SEG).catch(
            () => undefined,
          );
        }
      }
    } catch {
      // best-effort: sem nome, o fallback assume
    }
  }
  return mapa;
}

// Cadeia de fallback do nome do remetente. Nunca devolve "users/123" cru para a
// tela — ver um id no lugar do colega e pior do que ver "Participante 4821".
function nomeDoAutor(
  autorId: string,
  displayName: string,
  ehApp: boolean,
  membros: Record<string, string>,
): string {
  const direto = String(displayName || "").trim();
  if (direto) return direto;
  const porMembro = membros[autorId];
  if (porMembro) return porMembro;
  if (ehApp) return "App";
  return `Participante ${autorId.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

function normalizarMensagem(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bruta: any,
  spaceId: string,
  membros: Record<string, string>,
): MensagemChat | null {
  if (!bruta) return null;
  // Mensagem apagada volta so com metadado, sem texto: nao serve para chamado.
  if (bruta.deletionMetadata) return null;

  const texto = String(bruta.text || "").trim();
  const anexos = Array.isArray(bruta.attachment) ? bruta.attachment : [];
  const temAnexo = anexos.length > 0;
  // Card puro de app (sem texto e sem anexo) e ruido de interface.
  if (!texto && !temAnexo) return null;

  const autorId = String(bruta.sender?.name || "");
  const ehApp = String(bruta.sender?.type || "") === "BOT";
  return {
    id: String(bruta.name || ""),
    spaceId,
    texto:
      texto ||
      `(anexo: ${anexos
        .map((a: { contentName?: string }) => a?.contentName || "arquivo")
        .join(", ")})`,
    autorId,
    autor: nomeDoAutor(autorId, bruta.sender?.displayName, ehApp, membros),
    autorEhApp: ehApp,
    hora: String(bruta.createTime || ""),
    threadName: String(bruta.thread?.name || ""),
    editado: Boolean(bruta.lastUpdateTime),
    temAnexo,
  };
}

// Uma pagina de mensagens do espaco, mais recentes primeiro.
//
// Custa 1 chamada ao Google por pagina: o messages.list ja devolve text, sender e
// createTime completos (nao existe o format=metadata do Gmail), entao nao ha um
// segundo GET por mensagem.
export async function listarMensagens(
  email: string,
  spaceId: string,
  opts: {
    pageSize?: number;
    pageToken?: string;
    ordem?: "ASC" | "DESC";
    desde?: string;
  } = {},
): Promise<PaginaMensagens> {
  const pageSize = Math.min(opts.pageSize || tamanhoPagina(), 1000);
  const ordem = opts.ordem || "DESC";
  // Filtro nativo por data: e o que faz "selecionar por periodo" nao precisar
  // baixar a conversa inteira para depois descartar.
  const filtro = opts.desde ? `createTime > "${opts.desde}"` : undefined;
  const chaveCache =
    `chat:pg:${spaceId}:${opts.pageToken || "_"}:${pageSize}:` +
    `${ordem}:${opts.desde || "_"}`;

  const cacheado = await cacheGet<PaginaMensagens>(chaveCache).catch(() => null);
  if (cacheado) return cacheado;

  // single-flight + fila: cache frio com N pedidos simultaneos vira 1 chamada.
  return comSingleFlight(chaveCache, async () => {
    const jaVeio = await cacheGet<PaginaMensagens>(chaveCache).catch(() => null);
    if (jaVeio) return jaVeio;

    const data = await comVagaNoEspaco(spaceId, () =>
      chatGet(email, `/${spaceId}/messages`, {
        pageSize,
        pageToken: opts.pageToken,
        orderBy: `createTime ${ordem}`,
        filter: filtro,
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brutas: any[] = Array.isArray(data?.messages) ? data.messages : [];
    // UMA resolucao de nomes por pagina, com os remetentes que realmente
    // aparecem nela — nada de uma chamada por mensagem.
    const remetentes = brutas
      .map((m) => String(m?.sender?.name || ""))
      .filter(Boolean);
    const membros = await resolverNomes(email, remetentes).catch(() => ({}));
    const mensagens = brutas
      .map((m) => normalizarMensagem(m, spaceId, membros))
      .filter((m): m is MensagemChat => m !== null);

    const pagina: PaginaMensagens = {
      mensagens,
      proximaPagina: String(data?.nextPageToken || ""),
    };
    await cacheSet(chaveCache, pagina, MSG_CACHE_TTL_SEG).catch(() => undefined);
    return pagina;
  });
}

// Mensagens especificas (as que o usuario marcou). Cache-first: normalmente elas
// acabaram de ser lidas na paginacao, entao o custo tende a ZERO chamadas.
export async function obterMensagens(
  email: string,
  spaceId: string,
  messageIds: string[],
): Promise<MensagemChat[]> {
  // Nomes dos participantes do espaco: cobre as mensagens que precisarem ser
  // buscadas avulsas (as que ja vieram do cache trazem o nome resolvido).
  const idsMembros = await membrosDoEspaco(email, spaceId).catch(
    () => [] as string[],
  );
  const membros = await resolverNomes(email, idsMembros).catch(() => ({}));
  const encontradas: MensagemChat[] = [];
  const faltando: string[] = [];

  for (const id of messageIds) {
    const cacheada = await cacheGet<MensagemChat>(`chat:msg:${id}`).catch(
      () => null,
    );
    if (cacheada) encontradas.push(cacheada);
    else faltando.push(id);
  }

  // Concorrencia limitada: 200 GETs de uma vez estourariam a cota do espaco.
  const LOTE = 5;
  for (let i = 0; i < faltando.length; i += LOTE) {
    const lote = faltando.slice(i, i + LOTE);
    const vindas = await Promise.all(
      lote.map((id) =>
        comVagaNoEspaco(spaceId, () => chatGet(email, `/${id}`))
          .then((bruta) => normalizarMensagem(bruta, spaceId, membros))
          .catch(() => null),
      ),
    );
    for (const m of vindas) {
      if (!m) continue;
      encontradas.push(m);
      await cacheSet(`chat:msg:${m.id}`, m, 600).catch(() => undefined);
    }
  }

  // Ordem CRONOLOGICA, nao a ordem em que o usuario clicou: o resumo da IA
  // depende de a conversa fazer sentido de cima para baixo.
  return encontradas.sort((a, b) => a.hora.localeCompare(b.hora));
}

// ---------------------------------------------------------------------------
// Texto para a IA e chave de idempotencia
// ---------------------------------------------------------------------------

function horaLegivel(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

// Mesmo formato de separador que o obterThread do Gmail usa — o prompt do Gemini
// ja foi escrito para ler "--- Mensagem i/N — de X em DATA ---".
export function montarTextoSelecionado(msgs: MensagemChat[]): {
  texto: string;
  participantes: string[];
  qtd: number;
  primeiraHora: string;
  ultimaHora: string;
} {
  const participantes: string[] = [];
  for (const m of msgs) {
    if (m.autor && !participantes.includes(m.autor)) participantes.push(m.autor);
  }
  const texto = msgs
    .map((m, i) => {
      const cab = `--- Mensagem ${i + 1}/${msgs.length} — de ${m.autor || "?"}${
        m.hora ? " em " + horaLegivel(m.hora) : ""
      } ---`;
      return `${cab}\n${m.texto || "(sem conteudo)"}`;
    })
    .join("\n\n");
  return {
    texto,
    participantes,
    qtd: msgs.length,
    primeiraHora: msgs[0]?.hora || "",
    ultimaHora: msgs[msgs.length - 1]?.hora || "",
  };
}

// Chave de idempotencia da selecao.
//
// Hash do conjunto ordenado de ids, e nao "spaceId + primeira mensagem": o mesmo
// atendente pode abrir DOIS chamados diferentes do mesmo espaco com selecoes que
// compartilham a primeira mensagem. Com chave por primeiro id, o segundo chamado
// seria engolido pela idempotencia e simplesmente nao existiria.
export function chaveDaSelecao(spaceId: string, messageIds: string[]): string {
  const curto = String(spaceId || "").replace(/^spaces\//, "");
  const hash = createHash("sha1")
    .update(
      messageIds
        .map((m) => String(m).trim())
        .filter(Boolean)
        .sort()
        .join("|"),
    )
    .digest("hex")
    .slice(0, 16);
  return `${curto}:${hash}`;
}

// Periodo legivel para o cabecalho do chamado ("14/08/2026 09:12 — 09:41").
export function periodoLegivel(inicio: string, fim: string): string {
  const a = horaLegivel(inicio);
  const b = horaLegivel(fim);
  if (!a) return "";
  if (!b || a === b) return a;
  const mesmoDia = a.slice(0, 10) === b.slice(0, 10);
  return `${a} — ${mesmoDia ? b.slice(11) : b}`;
}
