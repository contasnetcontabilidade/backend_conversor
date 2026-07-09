import { AppError, getErrorMessage, isRecord } from "../lib/errors";

// Cliente da API Publica v1 do Suite360/SuiteWeb.
// Base: https://suiteweb.contasnet.com.br/api/public/v1
// Auth:  Authorization: Bearer <SUITE360_API_KEY>
//
// Envelope confirmado da API:
//   erro    -> { success: false, error: { code, message, details? } }
//   sucesso -> { success: true, data: ... }  (assumido; parsers sao defensivos)
//
// Em desenvolvimento o POST /chamados fica DESLIGADO (SUITE360_DRY_RUN=1): a
// criacao e apenas simulada, retornando o body que SERIA enviado. As consultas
// GET (read-only) batem na API real.

const DEFAULT_BASE_URL = "https://suiteweb.contasnet.com.br/api/public/v1";

function baseUrl(): string {
  return (process.env.SUITE360_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function apiKey(): string {
  return (
    process.env.SUITE360_API_KEY ||
    process.env.SUITEWEB_API_KEY ||
    ""
  ).trim();
}

export function isDryRun(): boolean {
  // Ligado por padrao. Só cria de verdade com SUITE360_DRY_RUN=0/false/no.
  const v = (process.env.SUITE360_DRY_RUN ?? "1").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

function envId(name: string): string | undefined {
  const v = (process.env[name] || "").trim();
  return v || undefined;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface SuiteResponse {
  status: number;
  body: unknown;
  retryAfter?: number;
}

async function suiteRequest(
  path: string,
  init: RequestInit = {},
): Promise<SuiteResponse> {
  const key = apiKey();
  if (!key) {
    throw new AppError({
      statusCode: 401,
      code: "SUITE_API_KEY_MISSING",
      message: "Chave da API do Suite360 nao configurada (SUITE360_API_KEY).",
    });
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(baseUrl() + path, { ...init, headers });
  } catch (error) {
    throw new AppError({
      statusCode: 502,
      code: "SUITE_UNREACHABLE",
      message: "Nao foi possivel conectar ao Suite360.",
      details: { cause: getErrorMessage(error) },
    });
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 500);
  }

  const retryAfterRaw = res.headers.get("retry-after");
  const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : undefined;

  return {
    status: res.status,
    body,
    retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
  };
}

function suiteErrorFrom(resp: SuiteResponse): AppError {
  const errObj =
    isRecord(resp.body) && isRecord(resp.body.error) ? resp.body.error : {};
  const upstreamCode =
    typeof errObj.code === "string" ? errObj.code : undefined;
  const upstreamMsg =
    typeof errObj.message === "string" ? errObj.message : undefined;
  const details = (errObj as Record<string, unknown>).details;

  switch (resp.status) {
    case 401:
      return new AppError({
        statusCode: 401,
        code: "SUITE_API_KEY_INVALID",
        message:
          upstreamMsg ||
          "Chave da API do Suite360 ausente, invalida, revogada ou expirada.",
        details: { upstreamCode },
      });
    case 404:
      return new AppError({
        statusCode: 404,
        code: "SUITE_NOT_FOUND",
        message:
          upstreamMsg || "Recurso nao encontrado no Suite360 (revisar IDs).",
        details: { upstreamCode },
      });
    case 422:
      return new AppError({
        statusCode: 422,
        code: "SUITE_VALIDATION",
        message: upstreamMsg || "Falha de validacao no Suite360.",
        details: { upstreamCode, details },
      });
    case 429:
      return new AppError({
        statusCode: 429,
        code: "SUITE_RATE_LIMITED",
        message: upstreamMsg || "Limite de requisicoes do Suite360 atingido.",
        details: { upstreamCode, retryAfter: resp.retryAfter },
      });
    default:
      return new AppError({
        statusCode: 502,
        code: "SUITE_REQUEST_FAILED",
        message: upstreamMsg || "Falha na chamada ao Suite360.",
        details: { upstreamCode, upstreamStatus: resp.status },
      });
  }
}

function isOk(resp: SuiteResponse): boolean {
  if (resp.status < 200 || resp.status >= 300) return false;
  if (isRecord(resp.body) && resp.body.success === false) return false;
  return true;
}

// GET com 1 retry em 429 (respeitando Retry-After, limitado).
async function suiteGet(path: string): Promise<unknown> {
  let resp = await suiteRequest(path, { method: "GET" });
  if (resp.status === 429) {
    const waitMs = Math.min((resp.retryAfter ?? 2) * 1000, 8000);
    await new Promise((r) => setTimeout(r, waitMs));
    resp = await suiteRequest(path, { method: "GET" });
  }
  if (!isOk(resp)) throw suiteErrorFrom(resp);
  return isRecord(resp.body) && "data" in resp.body ? resp.body.data : resp.body;
}

// Normaliza "data" para uma lista, tolerando varios formatos de paginacao.
function asList(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (isRecord(data)) {
    for (const key of ["items", "data", "results", "registros", "rows"]) {
      if (Array.isArray(data[key])) {
        return (data[key] as unknown[]).filter(isRecord);
      }
    }
    // objeto unico -> lista de 1
    return [data];
  }
  return [];
}

function pickId(obj: Record<string, unknown>): string | undefined {
  for (const k of ["id", "cliente_id", "client_id", "clienteId"]) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function pickStr(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Telefone: normalizacao + variacoes
// ---------------------------------------------------------------------------

export interface VariacaoTelefone {
  valor: string;
  confianca: "alta" | "baixa";
}

// Gera variacoes de busca do telefone, em ordem de confianca.
// alta: bateu com DDI (55) ou DDD+numero completo.
// baixa: apenas ultimos 8/9 digitos (fallback, nunca cria chamado sozinho).
export function normalizarTelefone(raw: string | undefined | null): {
  digitos: string;
  variacoes: VariacaoTelefone[];
} {
  const digitos = String(raw ?? "").replace(/\D+/g, "");
  const semDDI = digitos.startsWith("55") ? digitos.slice(2) : digitos;
  const comDDI = "55" + semDDI;

  const vistos = new Set<string>();
  const variacoes: VariacaoTelefone[] = [];
  const add = (valor: string, confianca: "alta" | "baixa") => {
    if (valor && valor.length >= 8 && !vistos.has(valor)) {
      vistos.add(valor);
      variacoes.push({ valor, confianca });
    }
  };

  add(comDDI, "alta");
  add(semDDI, "alta");
  add(semDDI.slice(-9), "baixa");
  add(semDDI.slice(-8), "baixa");

  return { digitos, variacoes };
}

// ---------------------------------------------------------------------------
// Resolucao de cliente por telefone (agenda de contatos do WhatsApp)
// ---------------------------------------------------------------------------

export interface ClienteResolvido {
  id: string;
  razao_social?: string;
  cnpj?: string;
}

export type ResolucaoCliente =
  | { status: "encontrado"; cliente: ClienteResolvido; via: string }
  | {
      status: "ambiguo";
      candidatos: Array<{ id: string; nome?: string; telefone?: string }>;
    }
  | { status: "nao_encontrado" }
  | { status: "erro"; motivo: string };

function telefoneDoContato(c: Record<string, unknown>): string {
  const t = pickStr(c, [
    "telefone",
    "phone",
    "numero",
    "number",
    "whatsapp",
    "celular",
  ]);
  return String(t ?? "").replace(/\D+/g, "");
}

// Busca o cliente pelo telefone na agenda de contatos do WhatsApp do Suite.
export async function resolverClientePorTelefone(
  numeroExterno: string | undefined,
): Promise<ResolucaoCliente> {
  const { variacoes } = normalizarTelefone(numeroExterno);
  if (!variacoes.length) return { status: "nao_encontrado" };

  try {
    for (const variacao of variacoes) {
      const data = await suiteGet(
        `/whatsapp/contatos?q=${encodeURIComponent(variacao.valor)}`,
      );
      const contatos = asList(data);
      if (!contatos.length) continue;

      // Match exato do telefone normalizado (evita falso positivo do ?q=).
      const exatos = contatos.filter((c) => {
        const tel = telefoneDoContato(c);
        return tel.endsWith(variacao.valor) || variacao.valor.endsWith(tel);
      });
      const alvo = exatos.length ? exatos : contatos;

      // Agrupa por cliente_id distinto.
      const porCliente = new Map<
        string,
        { id: string; nome?: string; telefone?: string }
      >();
      for (const c of alvo) {
        const clienteId =
          pickStr(c, ["cliente_id", "client_id", "clienteId"]) ||
          (isRecord(c.cliente) ? pickId(c.cliente) : undefined);
        if (!clienteId) continue;
        if (!porCliente.has(clienteId)) {
          porCliente.set(clienteId, {
            id: clienteId,
            nome: pickStr(c, ["nome", "name", "razao_social", "cliente_nome"]),
            telefone: telefoneDoContato(c) || variacao.valor,
          });
        }
      }

      if (porCliente.size === 1 && variacao.confianca === "alta") {
        const only = [...porCliente.values()][0];
        const cliente = await buscarClientePorId(only.id).catch(() => ({
          id: only.id,
          razao_social: only.nome,
        }));
        return { status: "encontrado", cliente, via: variacao.valor };
      }
      if (porCliente.size >= 1) {
        // multiplos, ou confianca baixa (ultimos 8/9): nunca auto -> manual.
        return { status: "ambiguo", candidatos: [...porCliente.values()] };
      }
    }
    return { status: "nao_encontrado" };
  } catch (error) {
    // Nao derruba o preview: registra e cai pra selecao manual no modal.
    return { status: "erro", motivo: getErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Cliente: por id / busca manual
// ---------------------------------------------------------------------------

export async function buscarClientePorId(
  clienteId: string,
): Promise<ClienteResolvido> {
  const data = await suiteGet(
    `/clientes?client_id=${encodeURIComponent(clienteId)}&with_tags=1`,
  ).catch(() => null);
  const registro = data
    ? asList(data)[0] || (isRecord(data) ? data : undefined)
    : undefined;

  if (registro) {
    return {
      id: pickId(registro) || clienteId,
      razao_social: pickStr(registro, [
        "razao_social",
        "nome",
        "name",
        "nome_fantasia",
      ]),
      cnpj: pickStr(registro, ["cnpj", "cpf_cnpj", "documento"]),
    };
  }
  return { id: clienteId };
}

export async function buscarClientes(params: {
  q?: string;
  cnpj?: string;
}): Promise<Array<{ id: string; razao_social?: string; cnpj?: string }>> {
  const query = params.cnpj
    ? `cnpj=${encodeURIComponent(params.cnpj.replace(/\D+/g, ""))}`
    : `q=${encodeURIComponent(params.q || "")}`;
  const data = await suiteGet(`/clientes?${query}`);
  return asList(data).map((c) => ({
    id: pickId(c) || "",
    razao_social: pickStr(c, ["razao_social", "nome", "name", "nome_fantasia"]),
    cnpj: pickStr(c, ["cnpj", "cpf_cnpj", "documento"]),
  }));
}

// ---------------------------------------------------------------------------
// Listas para os dropdowns do modal (proxy — chave fica no backend)
// ---------------------------------------------------------------------------

export interface ItemLista {
  id: string;
  nome: string;
  extra?: string;
}

function norm(s: string | undefined): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export async function buscarTipos(q?: string): Promise<ItemLista[]> {
  const query = q && q.trim() ? `&q=${encodeURIComponent(q.trim())}` : "";
  const data = await suiteGet(`/tipos-chamado?ativo=1${query}`);
  return asList(data).map((t) => ({
    id: pickId(t) || "",
    nome: pickStr(t, ["nome", "name", "descricao"]) || "",
    extra: isRecord(t.categoria)
      ? pickStr(t.categoria, ["nome", "descricao"])
      : undefined,
  }));
}

export async function buscarSetores(): Promise<ItemLista[]> {
  const data = await suiteGet("/setores");
  return asList(data).map((s) => ({
    id: pickId(s) || "",
    nome: pickStr(s, ["descricao", "nome", "name"]) || "",
  }));
}

export async function buscarOrigens(): Promise<ItemLista[]> {
  const data = await suiteGet("/origens-chamado");
  return asList(data).map((o) => ({
    id: pickId(o) || "",
    nome: pickStr(o, ["descricao", "nome", "name"]) || "",
  }));
}

export async function buscarUsuarios(q?: string): Promise<ItemLista[]> {
  const query = q && q.trim() ? `&q=${encodeURIComponent(q.trim())}` : "";
  const data = await suiteGet(`/usuarios?ativo=1${query}`);
  return asList(data).map((u) => ({
    id: pickId(u) || "",
    nome: pickStr(u, ["nome", "name"]) || "",
    extra: pickStr(u, ["email", "funcao"]),
  }));
}

// ---------------------------------------------------------------------------
// Resolucao automatica para o preview (a partir da chamada + sugestao da IA)
// ---------------------------------------------------------------------------

// Nome do GoTo vem como "NOME - SETOR". Helpers para separar as duas partes.
function deptDoNomeGoTo(nome: string | undefined): string {
  const s = String(nome || "");
  const i = s.lastIndexOf(" - ");
  return i >= 0 ? s.slice(i + 3).trim() : "";
}
function nomeSemDept(nome: string | undefined): string {
  const s = String(nome || "");
  const i = s.lastIndexOf(" - ");
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

// Aliases dept(GoTo) -> nome de setor no Suite. desenvolvimento == tecnologia
// (mesmo time). Overrides/extensao por env SUITE360_SETOR_ALIASES ("chave=Setor;...").
function aliasesSetor(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const par of (process.env.SUITE360_SETOR_ALIASES || "").split(/[;\n]/)) {
    const [k, v] = par.split("=");
    if (k && v) map[norm(k)] = v.trim();
  }
  const dev = norm("desenvolvimento");
  const tec = norm("tecnologia");
  if (map[dev] && !map[tec]) map[tec] = map[dev];
  if (map[tec] && !map[dev]) map[dev] = map[tec];
  return map;
}

// Setor pelo NOME do usuario do GoTo ("NOME - SETOR"): usa o dept apos o " - ".
export async function resolverSetorPorNomeUsuario(
  nomeGoTo: string | undefined,
): Promise<RefResolvida> {
  let dept = deptDoNomeGoTo(nomeGoTo);
  if (!dept) return { fonte: "ausente" };
  const aliases = aliasesSetor();
  if (aliases[norm(dept)]) dept = aliases[norm(dept)];
  const alvo = norm(dept);
  try {
    const setores = await buscarSetores();
    const s =
      setores.find((x) => norm(x.nome) === alvo) ||
      setores.find(
        (x) => norm(x.nome).includes(alvo) || alvo.includes(norm(x.nome)),
      );
    if (!s) return { fonte: "ausente" };
    return { id: s.id, nome: s.nome, fonte: "lookup" };
  } catch {
    return { fonte: "ausente" };
  }
}

// Executor = usuario do Suite cujo nome bate com o do usuario do GoTo
// (removendo o sufixo " - SETOR", que o Suite nao tem).
export async function resolverExecutorPorNome(
  nome: string | undefined,
): Promise<RefResolvida> {
  const nomeLimpo = nomeSemDept(nome);
  const alvo = norm(nomeLimpo);
  if (!alvo) return { fonte: "ausente" };
  try {
    const data = await suiteGet(
      `/usuarios?ativo=1&q=${encodeURIComponent(nomeLimpo)}`,
    );
    const lista = asList(data);
    const nomeDe = (u: Record<string, unknown>) =>
      norm(pickStr(u, ["nome", "name"]));
    let u =
      lista.find((x) => nomeDe(x) === alvo) ||
      lista.find((x) => nomeDe(x).includes(alvo) || alvo.includes(nomeDe(x)));
    if (!u) return { fonte: "ausente" };
    return {
      id: pickId(u),
      nome: pickStr(u, ["nome", "name"]),
      fonte: "lookup",
    };
  } catch {
    return { fonte: "ausente" };
  }
}

// Setor = setor cadastrado cujo nome bate com o sugerido pela IA.
export async function resolverSetorPorNome(
  nomeIA: string | undefined,
): Promise<RefResolvida> {
  const alvo = norm(nomeIA);
  if (!alvo) return { fonte: "ausente" };
  try {
    const setores = await buscarSetores();
    let s =
      setores.find((x) => norm(x.nome) === alvo) ||
      setores.find(
        (x) => norm(x.nome).includes(alvo) || alvo.includes(norm(x.nome)),
      );
    if (!s) return { fonte: "ausente" };
    return { id: s.id, nome: s.nome, fonte: "lookup" };
  } catch {
    return { fonte: "ausente" };
  }
}

// Assunto/tipo = melhor tipo de chamado para o texto sugerido pela IA
// (maior sobreposicao de palavras).
export async function resolverAssuntoPorTexto(
  texto: string | undefined,
): Promise<RefResolvida> {
  const t = norm(texto);
  if (!t) return { fonte: "ausente" };
  try {
    const lista = await buscarTipos(texto);
    if (!lista.length) return { fonte: "ausente" };
    const palavras = t.split(/\s+/).filter((w) => w.length > 2);
    let melhor = lista[0];
    let melhorScore = -1;
    for (const item of lista) {
      const n = norm(item.nome);
      const score = palavras.reduce((acc, w) => acc + (n.includes(w) ? 1 : 0), 0);
      if (score > melhorScore) {
        melhorScore = score;
        melhor = item;
      }
    }
    // Sem nenhuma palavra em comum -> nao arrisca; deixa manual.
    if (melhorScore <= 0) return { fonte: "ausente" };
    return { id: melhor.id, nome: melhor.nome, fonte: "lookup" };
  } catch {
    return { fonte: "ausente" };
  }
}

// ---------------------------------------------------------------------------
// Resolucao de tipo / origem / setor / executor (env -> lookup)
// ---------------------------------------------------------------------------

export interface RefResolvida {
  id?: string;
  nome?: string;
  fonte: "env" | "lookup" | "ausente";
}

async function lookupPrimeiro(
  path: string,
  filtro?: (r: Record<string, unknown>) => boolean,
): Promise<{ id?: string; nome?: string }> {
  const data = await suiteGet(path).catch(() => null);
  const lista = data ? asList(data) : [];
  // Com filtro: exige match (nao cai pro primeiro item, evitando escolher um
  // tipo/origem errado). Sem filtro: usa o primeiro (ja veio filtrado por ?q=).
  const escolhido = filtro ? lista.find(filtro) : lista[0];
  if (!escolhido) return {};
  return {
    id: pickId(escolhido),
    nome: pickStr(escolhido, ["nome", "name", "descricao", "titulo"]),
  };
}

export async function resolverTipoApontamento(): Promise<RefResolvida> {
  const envVal = envId("SUITE360_TIPO_APONTAMENTO_ID");
  if (envVal) return { id: envVal, fonte: "env" };
  try {
    // Regex ESTREITO de proposito: com centenas de tipos, so casa termos bem
    // especificos de atendimento por telefone. Sem match -> "ausente" (o
    // usuario define SUITE360_TIPO_APONTAMENTO_ID). Nunca chuta um tipo qualquer.
    const pref = /atendimento telef|telefonic|ligac|ligaç|demanda geral/i;
    const r = await lookupPrimeiro("/tipos-chamado?ativo=1", (t) => {
      const nome = pickStr(t, ["nome", "name", "descricao", "titulo"]) || "";
      return pref.test(nome);
    });
    return r.id ? { ...r, fonte: "lookup" } : { fonte: "ausente" };
  } catch {
    return { fonte: "ausente" };
  }
}

export async function resolverOrigem(): Promise<RefResolvida> {
  const envVal = envId("SUITE360_ORIGEM_ID");
  if (envVal) return { id: envVal, fonte: "env" };
  try {
    // Busca a origem certa para uma ligacao telefonica: prefere "Telefone" ou
    // "Ligacao"; so cai para "WhatsApp" se nao houver. (Lista tem ~5 itens.)
    const preferida = /telefon|ligac|ligaç/i;
    let r = await lookupPrimeiro("/origens-chamado", (o) =>
      preferida.test(pickStr(o, ["descricao", "nome", "name"]) || ""),
    );
    if (!r.id) {
      r = await lookupPrimeiro("/origens-chamado", (o) =>
        /whats/i.test(pickStr(o, ["descricao", "nome", "name"]) || ""),
      );
    }
    return r.id ? { ...r, fonte: "lookup" } : { fonte: "ausente" };
  } catch {
    return { fonte: "ausente" };
  }
}

export async function resolverSetor(): Promise<RefResolvida> {
  const envVal = envId("SUITE360_SETOR_ID");
  if (envVal) return { id: envVal, fonte: "env" };
  const nome = (process.env.SUITE360_SETOR_NOME || "").trim();
  if (!nome) return { fonte: "ausente" };
  try {
    const r = await lookupPrimeiro(`/setores?q=${encodeURIComponent(nome)}`);
    return r.id ? { ...r, fonte: "lookup" } : { fonte: "ausente" };
  } catch {
    return { fonte: "ausente" };
  }
}

export async function resolverExecutor(): Promise<RefResolvida> {
  const envVal = envId("SUITE360_EXECUTOR_ID");
  if (envVal) return { id: envVal, fonte: "env" };
  const q = (process.env.SUITE360_EXECUTOR_Q || "").trim();
  if (!q) return { fonte: "ausente" };
  try {
    const r = await lookupPrimeiro(
      `/usuarios?ativo=1&q=${encodeURIComponent(q)}`,
    );
    return r.id ? { ...r, fonte: "lookup" } : { fonte: "ausente" };
  } catch {
    return { fonte: "ausente" };
  }
}

// ---------------------------------------------------------------------------
// Descricao do chamado (padrao fixo)
// ---------------------------------------------------------------------------

export interface DadosDescricao {
  razaoSocial?: string;
  cnpj?: string;
  dataHora?: string;
  telefoneOrigem?: string;
  telefoneDestino?: string;
  duracao?: string;
  atendente?: string;
  idChamadaGoto?: string;
  resumo?: string;
  pontosPrincipais?: string[];
  providencias?: string[];
  transcricao?: string;
  gravacao?: string;
}

function linhas(itens?: string[]): string {
  if (!itens || !itens.length) return "-";
  return itens.map((i) => `- ${i}`).join("\n");
}

export function montarDescricao(d: DadosDescricao): string {
  const cliente =
    [d.razaoSocial, d.cnpj].filter(Boolean).join(" - ") || "(nao identificado)";
  return `Atendimento telefonico registrado automaticamente.

Cliente:
${cliente}

Dados da chamada:
- Data/hora: ${d.dataHora || "-"}
- Telefone origem: ${d.telefoneOrigem || "-"}
- Telefone destino: ${d.telefoneDestino || "-"}
- Duracao: ${d.duracao || "-"}
- Atendente/ramal: ${d.atendente || "-"}
- ID da chamada GoTo: ${d.idChamadaGoto || "-"}

Resumo:
${d.resumo || "-"}

Pontos principais:
${linhas(d.pontosPrincipais)}

Providencias sugeridas:
${linhas(d.providencias)}

Transcricao:
${d.transcricao || "-"}

Gravacao:
${d.gravacao || "-"}`;
}

// ---------------------------------------------------------------------------
// Criacao do chamado (POST) — gated por dry-run
// ---------------------------------------------------------------------------

export interface ChamadoBody {
  cliente_id: string | number;
  tipo_apontamento_id: string | number;
  descricao: string;
  origem_id: string | number;
  setores_vinculados: (string | number)[];
  executor_id: string | number;
}

export interface CriacaoChamado {
  dryRun: boolean;
  body?: ChamadoBody; // presente quando dryRun
  id?: string; // presente quando criado de verdade
  protocolo?: string; // presente quando criado de verdade
}

// Valida que nenhum ID obrigatorio esta faltando.
export function validarChamadoBody(body: Partial<ChamadoBody>): string[] {
  const faltando: string[] = [];
  if (!body.cliente_id) faltando.push("cliente_id");
  if (!body.tipo_apontamento_id) faltando.push("tipo_apontamento_id");
  if (!body.origem_id) faltando.push("origem_id");
  if (!body.executor_id) faltando.push("executor_id");
  if (!body.setores_vinculados || !body.setores_vinculados.length) {
    faltando.push("setores_vinculados");
  }
  if (!body.descricao || !String(body.descricao).trim()) {
    faltando.push("descricao");
  }
  return faltando;
}

export async function criarChamado(body: ChamadoBody): Promise<CriacaoChamado> {
  if (isDryRun()) {
    return { dryRun: true, body };
  }

  const resp = await suiteRequest("/chamados", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (resp.status === 201 || (resp.status >= 200 && resp.status < 300)) {
    if (isRecord(resp.body) && resp.body.success === false) {
      throw suiteErrorFrom(resp);
    }
    const data =
      isRecord(resp.body) && isRecord(resp.body.data)
        ? resp.body.data
        : isRecord(resp.body)
          ? resp.body
          : {};
    const id = pickId(data) || "";
    const protocolo = pickStr(data, ["protocolo", "protocol", "numero"]) || "";
    return { dryRun: false, id, protocolo };
  }

  throw suiteErrorFrom(resp);
}
