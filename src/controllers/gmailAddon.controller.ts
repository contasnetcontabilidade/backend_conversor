// Painel do Gmail (complemento do Google Workspace): abrir chamado sem sair do
// e-mail. PILOTO.
//
// O painel faz o mesmo que a aba E-mails do desktop e chama os MESMOS
// controllers de preview e de criacao (gmail.controller). Assim as regras ja
// validadas (idempotencia, anexos conferidos no Gmail, marcador removido, custo
// e falhas no /admin) valem aqui sem copia, e os dois caminhos nao divergem.
//
// O que muda em relacao ao desktop:
//  - Quem e a pessoa vem do Google (ID token verificado), nao do perfil do app.
//    Executor e setor saem do usuario do Suite com o MESMO e-mail.
//  - O e-mail e lido com os tokens que o app ja guardou no Redis quando a pessoa
//    conectou a conta Google. Sem o app conectado, o painel pede para conectar.
//  - O Google espera a resposta por ~30 s, e a IA pode passar disso numa
//    conversa longa: o preview continua em segundo plano e a tela oferece
//    "Atualizar".
//  - O cartao do Google nao guarda estado entre cliques. O que a pessoa ja
//    escolheu fica num rascunho no Redis, e cada clique manda so o id dele.
//
// Fora do piloto (continua no app): competencia, prioridade, prazo,
// visibilidade, varias empresas, processos e o modo "responsavel da empresa".

import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import { waitUntil } from "@vercel/functions";
import { AppError, getErrorMessage, isRecord } from "../lib/errors";
import { gmailCriarController, gmailPreviewController } from "./gmail.controller";
import { feedbackController } from "./admin.controller";
import { verificarIdTokenGoogle } from "../services/googleIdToken";
import { resolverContaGoogle } from "../services/googleConta";
import {
  cacheGet,
  cacheSet,
  getChamadoCriado,
  salvarContaDoEmail,
} from "../services/store";
import { montarChamadoBodyDaRequisicao } from "../services/chamadoPayload";
import {
  buscarCamposDoTipo,
  buscarClientes,
  buscarOrigens,
  buscarSetores,
  buscarTipos,
  buscarUsuarios,
  montarDescricaoEmail,
  validarChamadoBody,
  type CampoPersonalizado,
  type ItemLista,
} from "../services/suite360";
import * as C from "../services/gmailAddonCards";

const TTL_RASCUNHO_SEG = 6 * 3600;
const TTL_PERFIL_SEG = 180 * 24 * 3600;
const TTL_USUARIO_SEG = 3600;
const TTL_USUARIO_AUSENTE_SEG = 600;
const TTL_LISTA_SEG = 600;
// Folga para o Google (~30 s) ainda receber e desenhar a resposta.
const ESPERA_PREVIEW_MS = 20_000;
// Preparacao "gerando" ha mais que isto morreu no caminho (a funcao da Vercel
// caiu, por exemplo): a tela deixa tentar de novo em vez de esperar para sempre.
const PREVIEW_ABANDONADO_MS = 4 * 60_000;
const MAX_OPCOES = 30;
const DOMINIOS_PADRAO = "contas.com.br,contasnet.com.br";
const PREFIXO_ROTAS = "/api/addon/gmail/";

const MSG_CONECTAR =
  "Sua conta Google ainda não está conectada ao Assistente de Reuniões. " +
  "No app, abra a aba E-mails e conecte a conta; depois volte aqui.";
const MSG_INESPERADO =
  "Erro inesperado. Tente de novo; se continuar, avise o suporte.";

// ---------------------------------------------------------------------------
// Tipos do rascunho
// ---------------------------------------------------------------------------

interface Opcao {
  id: string;
  nome: string;
  cnpj?: string;
}

interface UsuarioSuite {
  id: string;
  nome: string;
  setorIds: string[];
}

interface FormRascunho {
  titulo: string;
  clienteId: string;
  assuntoId: string;
  origemId: string;
  setorId: string;
  executorId: string;
  finalizado: boolean;
  corpo: string; // so a parte editavel da descricao (ver partesDescricao)
  anexos: string[];
  setoresExtra: string[];
  pessoas: string[];
  campos: Record<string, string | boolean>;
}

interface PreviewGmail {
  dryRun: boolean;
  iaOk: boolean;
  email: { de: string; assunto: string; data: string };
  chamada: {
    remetente?: string;
    assunto?: string;
    dataHora?: string;
    atendente?: string;
  };
  ia: { resumo: string; pontos: string[]; providencias: string[] };
  anexos: Array<{
    id: string;
    nome: string;
    tamanhoTexto: string;
    bloqueado: boolean;
    motivo: string;
  }>;
  setoresSugeridos: Opcao[];
  pessoasSugeridas: Opcao[];
}

interface Rascunho {
  id: string;
  conta: string;
  threadId: string;
  messageId: string;
  status: "gerando" | "pronto" | "erro";
  iniciadoEm: number;
  erro?: string;
  simular?: boolean;
  usuario?: UsuarioSuite;
  preview?: PreviewGmail;
  form?: FormRascunho;
  corpoSistema?: string;
  opcoes?: { clientes: Opcao[]; assuntos: Opcao[]; executores: Opcao[] };
  camposDef?: CampoPersonalizado[];
  // O que a IA/sistema sugeriu ao abrir, nunca sobrescrito: e a base do
  // feedback implicito (sugerido x escolhido).
  sugestao?: {
    clienteId: string;
    clienteVia: string;
    setorId: string;
    executorId: string;
    assuntoId: string;
    assuntoNome: string;
    finalizado: boolean;
    finalizadoMotivo?: string;
  };
  criado?: {
    protocolo: string;
    jaExistia: boolean;
    dryRun: boolean;
    avisos: string[];
    feedback?: "up" | "down" | "abrindo";
  };
}

interface Ctx {
  evento: unknown;
  conta: string;
  simular: boolean;
  url: (acao: string) => string;
}

// ---------------------------------------------------------------------------
// Identidade: o pedido veio do Google, e de quem?
// ---------------------------------------------------------------------------

function urlBase(req: Request): string {
  const env = (process.env.ADDON_BASE_URL || "").trim().replace(/\/+$/, "");
  return env || `https://${req.get("host")}`;
}

// Dois tokens, duas perguntas:
//  - Authorization (token de SISTEMA): o pedido veio do Google, em nome DESTE
//    complemento? Confere a conta de servico do complemento.
//  - userIdToken (token do USUARIO): quem esta com o Gmail aberto? Confere o
//    client ID do complemento e o dominio da empresa.
// Sem as duas variaveis configuradas o painel fica FECHADO, nunca aberto.
async function identificar(req: Request): Promise<string> {
  // Teste local: so fora da Vercel, para um esquecimento no .env de producao
  // nunca abrir a porta.
  if (process.env.ADDON_SEM_VERIFICACAO === "1" && !process.env.VERCEL) {
    const email = (process.env.ADDON_DEV_EMAIL || "").trim().toLowerCase();
    if (email) return email;
  }

  const contaServico = (process.env.ADDON_SERVICE_ACCOUNT || "")
    .trim()
    .toLowerCase();
  const clientId = (process.env.ADDON_OAUTH_CLIENT_ID || "").trim();
  if (!contaServico || !clientId) {
    throw new AppError({
      statusCode: 503,
      code: "ADDON_NAO_CONFIGURADO",
      message: "O painel do Gmail ainda não foi configurado no servidor.",
    });
  }

  const auth = req.get("authorization") || "";
  const tokenSistema = /^Bearer\s+(.+)$/i.exec(auth)?.[1] || "";
  const base = urlBase(req);
  // A audiencia do token de sistema e a URL que o Google chamou. Aceita
  // qualquer rota deste servidor: quem garante que e o NOSSO complemento e a
  // conta de servico logo abaixo.
  const sistema = await verificarIdTokenGoogle(tokenSistema, {
    audiencia: (aud) => aud === base || aud.startsWith(`${base}/`),
  });
  if (!sistema.email_verified || (sistema.email || "").toLowerCase() !== contaServico) {
    throw new AppError({
      statusCode: 401,
      code: "ADDON_TOKEN_INVALIDO",
      message: "Não foi possível confirmar que o pedido veio do Google.",
      details: { motivo: "conta de servico", email: sistema.email },
    });
  }

  const evento = isRecord(req.body) ? req.body : {};
  const aut = isRecord(evento.authorizationEventObject)
    ? evento.authorizationEventObject
    : {};
  const tokenUsuario = typeof aut.userIdToken === "string" ? aut.userIdToken : "";
  const usuario = await verificarIdTokenGoogle(tokenUsuario, {
    audiencia: (aud) => aud === clientId,
  });
  const email = (usuario.email || "").trim().toLowerCase();
  if (!email || !usuario.email_verified) {
    throw new AppError({
      statusCode: 401,
      code: "ADDON_TOKEN_INVALIDO",
      message: "Não foi possível confirmar que o pedido veio do Google.",
      details: { motivo: "usuario sem e-mail verificado" },
    });
  }

  const dominios = (process.env.ADDON_DOMINIOS || DOMINIOS_PADRAO)
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (!dominios.includes(email.split("@")[1] || "")) {
    throw new AppError({
      statusCode: 403,
      code: "ADDON_DOMINIO_NAO_PERMITIDO",
      message: "Este painel é só para contas da empresa.",
      details: { email },
    });
  }
  return email;
}

// ---------------------------------------------------------------------------
// Ponte para os controllers do desktop
// ---------------------------------------------------------------------------

// Chama um controller do app como funcao comum. Adaptador em vez de refatorar
// os controllers: eles rodam em producao para o desktop, e o painel precisa do
// mesmo comportamento, nao de uma segunda versao. Eles so usam req.body e
// res.status().json(); erro sobe como AppError, igual ao caminho HTTP.
async function chamar(
  controller: (req: Request, res: Response) => Promise<void>,
  body: Record<string, unknown>,
): Promise<{ status: number; corpo: Record<string, unknown> }> {
  let status = 200;
  let corpo: Record<string, unknown> = {};
  const res = {
    status(c: number) {
      status = c;
      return res;
    },
    json(b: unknown) {
      corpo = isRecord(b) ? b : {};
      return res;
    },
  };
  const limpo = Object.fromEntries(
    Object.entries(body).filter(([, v]) => v !== undefined && v !== ""),
  );
  await controller(
    { body: limpo, query: {}, headers: {} } as unknown as Request,
    res as unknown as Response,
  );
  return { status, corpo };
}

// ---------------------------------------------------------------------------
// Rascunho no Redis
// ---------------------------------------------------------------------------

const chaveRascunho = (id: string) => `addon:gmail:rasc:${id}`;
const chaveItem = (conta: string, item: string) =>
  `addon:gmail:item:${conta}:${item}`;
const chavePerfil = (conta: string) => `addon:gmail:perfil:${conta}`;
const itemDo = (r: { threadId: string; messageId: string }) =>
  r.threadId || r.messageId;

async function salvarRascunho(r: Rascunho): Promise<void> {
  await cacheSet(chaveRascunho(r.id), r, TTL_RASCUNHO_SEG);
}

async function lerRascunho(id: string, conta: string): Promise<Rascunho> {
  const r = id ? await cacheGet<Rascunho>(chaveRascunho(id)) : null;
  // A conta confere de proposito: o id do rascunho viaja no cartao.
  if (!r || r.conta !== conta) {
    throw new AppError({
      statusCode: 410,
      code: "ADDON_RASCUNHO_EXPIROU",
      message:
        "Esta revisão expirou. Abra o e-mail de novo e clique em Preparar chamado.",
    });
  }
  return r;
}

// ---------------------------------------------------------------------------
// Dados de apoio (Suite)
// ---------------------------------------------------------------------------

async function listaCacheada(
  chave: string,
  buscar: () => Promise<ItemLista[]>,
): Promise<Opcao[]> {
  const cache = await cacheGet<Opcao[]>(chave).catch(() => null);
  if (Array.isArray(cache) && cache.length) return cache;
  const itens = (await buscar())
    .filter((i) => i.id)
    .map((i) => ({ id: String(i.id), nome: i.nome || String(i.id) }));
  await cacheSet(chave, itens, TTL_LISTA_SEG).catch(() => undefined);
  return itens;
}

const listaSetores = () => listaCacheada("addon:lista:setores", buscarSetores);
const listaOrigens = () => listaCacheada("addon:lista:origens", buscarOrigens);

// Usuario do Suite com o MESMO e-mail da conta Google. E o equivalente do
// "Configurar Perfil" do app. Dois usuarios com o mesmo e-mail nao viram
// sugestao: melhor o executor vazio que o chamado no nome de outra pessoa.
async function usuarioSuite(conta: string): Promise<UsuarioSuite | undefined> {
  const chave = `addon:gmail:usuario:${conta}`;
  const cache = await cacheGet<UsuarioSuite | { nenhum: true }>(chave).catch(
    () => null,
  );
  if (cache) return "nenhum" in cache ? undefined : cache;

  const { itens } = await buscarUsuarios();
  const achados = itens.filter(
    (u) => (u.extra || "").trim().toLowerCase() === conta,
  );
  const u = achados.length === 1 ? achados[0] : undefined;
  if (!u) {
    console.warn(
      `[addon:gmail] conta=${conta} sem usuario unico no Suite (achados=${achados.length})`,
    );
    await cacheSet(chave, { nenhum: true }, TTL_USUARIO_AUSENTE_SEG).catch(
      () => undefined,
    );
    return undefined;
  }
  const valor: UsuarioSuite = {
    id: String(u.id),
    nome: u.nome,
    setorIds: (u.setorIds && u.setorIds.length
      ? u.setorIds
      : u.setorId
        ? [u.setorId]
        : []
    ).map(String),
  };
  await cacheSet(chave, valor, TTL_USUARIO_SEG).catch(() => undefined);
  return valor;
}

// Setor de quem registra: o ultimo usado no painel (se ainda for dela) ou o
// unico setor da pessoa no Suite. Com varios e nenhum historico, fica vazio.
async function setorInicial(
  conta: string,
  usuario?: UsuarioSuite,
): Promise<string | undefined> {
  const ids = usuario?.setorIds || [];
  const perfil = await cacheGet<{ setorId?: string }>(chavePerfil(conta)).catch(
    () => null,
  );
  if (perfil?.setorId && (!ids.length || ids.includes(perfil.setorId))) {
    return perfil.setorId;
  }
  return ids.length === 1 ? ids[0] : undefined;
}

// ---------------------------------------------------------------------------
// Descricao
// ---------------------------------------------------------------------------

// A descricao tem duas partes, como no desktop (montarDescricaoEmailJS): o
// cabecalho (cliente e dados do e-mail), que o sistema refaz quando o cliente
// muda, e o corpo (resumo, pontos, providencias), que a pessoa edita. Editar o
// resumo nunca pode deixar o cliente antigo no texto.
// O corte usa o proprio montarDescricaoEmail do backend para o texto sair
// identico ao do app.
function partesDescricao(
  p: PreviewGmail,
  cliente?: Opcao,
): { cabecalho: string; corpo: string } {
  const completo = montarDescricaoEmail({
    razaoSocial: cliente?.nome,
    cnpj: cliente?.cnpj,
    remetente: p.chamada.remetente,
    assunto: p.chamada.assunto,
    dataHora: p.chamada.dataHora,
    atendente: p.chamada.atendente,
    resumo: p.ia.resumo,
    pontosPrincipais: p.ia.pontos,
    providencias: p.ia.providencias,
  });
  const i = completo.indexOf("\n\nResumo:\n");
  return i >= 0
    ? { cabecalho: completo.slice(0, i), corpo: completo.slice(i + 2) }
    : { cabecalho: "", corpo: completo };
}

function clienteEscolhido(r: Rascunho): Opcao | undefined {
  const id = r.form?.clienteId;
  return id ? r.opcoes?.clientes.find((c) => c.id === id) || { id, nome: "" } : undefined;
}

function descricaoFinal(r: Rascunho): string {
  const { cabecalho } = partesDescricao(r.preview!, clienteEscolhido(r));
  return [cabecalho, (r.form?.corpo || "").trim()].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Preparar (preview em segundo plano)
// ---------------------------------------------------------------------------

async function gerarRascunho(r: Rascunho): Promise<void> {
  const inicio = Date.now();
  try {
    const usuario = await usuarioSuite(r.conta).catch((error) => {
      console.warn(
        `[addon:gmail:preparar] rasc=${r.id} usuarios do Suite falharam: ${getErrorMessage(error)}`,
      );
      return undefined;
    });
    const setorId = await setorInicial(r.conta, usuario);
    const setorNome = setorId
      ? (await listaSetores().catch(() => [] as Opcao[])).find(
          (s) => s.id === setorId,
        )?.nome
      : undefined;

    const { corpo } = await chamar(gmailPreviewController, {
      email: r.conta,
      ...(r.threadId ? { threadId: r.threadId } : { messageId: r.messageId }),
      // A versao de teste chama a IA de verdade, mas nunca vira chamado: o
      // gasto entra no /admin com o ramal de teste, para nao aparecer como
      // "IA sem chamado" de uso real.
      ramal: r.simular ? ramalDeTeste() : undefined,
      usuario: usuario?.nome || r.conta,
      executorId: usuario?.id,
      executorNome: usuario?.nome,
      setorId,
      setorNome,
    });
    const d = isRecord(corpo.data) ? (corpo.data as Record<string, any>) : {};
    const refs = d.refs || {};
    const ia = d.ia || {};
    const cli =
      d.cliente?.status === "encontrado" && d.cliente.cliente
        ? d.cliente.cliente
        : undefined;
    const cliente: Opcao | undefined = cli
      ? { id: String(cli.id), nome: cli.razao_social || String(cli.id), cnpj: cli.cnpj }
      : undefined;
    const opc = (i: { id?: unknown; nome?: string }) => ({
      id: String(i.id),
      nome: i.nome || String(i.id),
    });

    r.usuario = usuario;
    r.preview = {
      dryRun: !!d.dryRun,
      iaOk: d.iaOk !== false,
      email: {
        de: d.email?.de || "",
        assunto: d.email?.assunto || "",
        data: d.email?.data || "",
      },
      chamada: d.chamada || {},
      ia: {
        resumo: ia.resumo || "",
        pontos: Array.isArray(ia.pontos_principais) ? ia.pontos_principais : [],
        providencias: Array.isArray(ia.providencias_sugeridas)
          ? ia.providencias_sugeridas
          : [],
      },
      anexos: (Array.isArray(d.anexos) ? d.anexos : []).map((a: any) => ({
        id: String(a.id),
        nome: String(a.nome || ""),
        tamanhoTexto: String(a.tamanhoTexto || ""),
        bloqueado: !!a.bloqueado,
        motivo: String(a.motivo || ""),
      })),
      setoresSugeridos: (refs.setoresVinculados?.itens || []).map(opc),
      pessoasSugeridas: (refs.usuariosVinculados?.itens || []).map(opc),
    };

    const setorFinal = refs.setor?.id ? String(refs.setor.id) : "";
    const { corpo: corpoDesc } = partesDescricao(r.preview, cliente);
    const finalizadoIa = refs.finalizaApontamento?.valor === true;
    r.form = {
      titulo: refs.titulo?.valor || ia.titulo || "",
      clienteId: cliente?.id || "",
      assuntoId: refs.tipo?.id ? String(refs.tipo.id) : "",
      origemId: refs.origem?.id ? String(refs.origem.id) : "",
      setorId: setorFinal,
      executorId: refs.executor?.id ? String(refs.executor.id) : "",
      finalizado: finalizadoIa,
      corpo: corpoDesc,
      anexos: [], // como no app: nenhum anexo vai sem a pessoa marcar
      setoresExtra: r.preview.setoresSugeridos
        .map((s) => s.id)
        .filter((id) => id !== setorFinal),
      pessoas: r.preview.pessoasSugeridas.map((p) => p.id),
      campos: {},
    };
    r.corpoSistema = corpoDesc;
    r.opcoes = {
      clientes: cliente ? [cliente] : [],
      assuntos: refs.tipo?.id ? [opc(refs.tipo)] : [],
      executores: refs.executor?.id ? [opc(refs.executor)] : [],
    };
    r.camposDef = refs.camposPersonalizados?.definicoes || [];
    r.sugestao = {
      clienteId: r.form.clienteId,
      clienteVia: cliente ? String(d.cliente?.via || "") : "",
      setorId: r.form.setorId,
      executorId: r.form.executorId,
      assuntoId: r.form.assuntoId,
      assuntoNome: refs.tipo?.nome || "",
      finalizado: finalizadoIa,
      finalizadoMotivo: refs.finalizaApontamento?.motivo,
    };
    r.status = "pronto";
    console.log(
      `[addon:gmail:preparar] rasc=${r.id} conta=${r.conta} item=${itemDo(r)} ` +
        `pronto em ${Date.now() - inicio}ms iaOk=${r.preview.iaOk} ` +
        `usuarioSuite=${usuario?.id || "-"}`,
    );
  } catch (error) {
    r.status = "erro";
    r.erro = mensagemParaPessoa(error);
    console.error(
      `[addon:gmail:preparar] rasc=${r.id} conta=${r.conta} item=${itemDo(r)} ` +
        `falhou em ${Date.now() - inicio}ms: ` +
        `${error instanceof AppError ? error.code : "sem code"} ${getErrorMessage(error)}`,
    );
  }
  await salvarRascunho(r).catch((error) => {
    console.error(
      `[addon:gmail:preparar] rasc=${r.id} NAO salvou o rascunho: ${getErrorMessage(error)}`,
    );
  });
}

// Mesma lista que o /admin usa para separar o gasto de teste (admin.controller).
function ramalDeTeste(): string {
  return (process.env.RAMAIS_TESTE || "258").split(",")[0].trim() || "258";
}

// Espera a tarefa ate `ms`; devolve se ela terminou a tempo.
async function terminouEm(tarefa: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const limite = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([tarefa.then(() => true), limite]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emSegundoPlano(tarefa: Promise<void>): void {
  try {
    waitUntil(tarefa);
  } catch {
    // Fora da Vercel o waitUntil nao existe; a tarefa segue no processo local.
  }
}

// ---------------------------------------------------------------------------
// Formulario: o que a pessoa escolheu volta para o rascunho a cada clique
// ---------------------------------------------------------------------------

// Toda acao vem da tela de revisao, que sempre tem estes campos: campo ausente
// no evento quer dizer que a pessoa o deixou vazio, nao que ele nao existia.
function absorverFormulario(r: Rascunho, evento: unknown): void {
  const f = r.form!;
  f.titulo = C.lerCampo(evento, "titulo");
  f.clienteId = C.lerCampo(evento, "cliente");
  f.assuntoId = C.lerCampo(evento, "assunto");
  f.origemId = C.lerCampo(evento, "origem");
  f.setorId = C.lerCampo(evento, "setor");
  f.executorId = C.lerCampo(evento, "executor");
  f.finalizado = C.lerInterruptor(evento, "finalizado");
  f.corpo = C.lerCampo(evento, "descricao");
  if (r.preview?.anexos.some((a) => !a.bloqueado)) {
    f.anexos = C.lerLista(evento, "anexos");
  }
  if (extrasDeSetor(r).length) f.setoresExtra = C.lerLista(evento, "setores_extra");
  if (r.preview?.pessoasSugeridas.length) f.pessoas = C.lerLista(evento, "pessoas");
  for (const d of r.camposDef || []) {
    const nome = `cp_${d.id}`;
    if (d.tipo === "booleano") f.campos[d.id] = C.lerInterruptor(evento, nome);
    else if (d.tipo === "data") f.campos[d.id] = C.lerData(evento, nome) || "";
    else f.campos[d.id] = C.lerCampo(evento, nome);
  }
}

function extrasDeSetor(r: Rascunho): Opcao[] {
  const principal = r.form?.setorId;
  return (r.preview?.setoresSugeridos || []).filter((s) => s.id !== principal);
}

const ROTULOS: Record<string, string> = {
  cliente_id: "cliente",
  tipo_apontamento_id: "assunto",
  origem_id: "origem",
  setores_vinculados: "setor",
  executor_id: "executor",
  responsavel_conclusao_id: "executor",
  descricao: "descrição",
  finaliza_apontamento: "criar já finalizado",
  competencia: "competência",
  prioridade: "prioridade",
  prazo_personalizado_data: "prazo",
};

function rotuloCampo(campo: string, defs: CampoPersonalizado[] = []): string {
  if (campo.startsWith("campo_personalizado:")) {
    const id = campo.slice("campo_personalizado:".length);
    return defs.find((d) => d.id === id)?.nome || `campo ${id}`;
  }
  return ROTULOS[campo] || campo;
}

// O que falta antes de mandar ao Suite, pelo nome que a pessoa ve na tela.
function faltando(r: Rascunho): string[] {
  const f = r.form!;
  const falta: string[] = [];
  if (!f.clienteId) falta.push("cliente");
  if (!f.assuntoId) falta.push("assunto");
  if (!f.origemId) falta.push("origem");
  if (!f.setorId) falta.push("setor");
  if (!f.executorId) falta.push("executor");
  if (!f.corpo.trim()) falta.push("descrição");
  for (const d of r.camposDef || []) {
    if (!d.obrigatorio) continue;
    const v = f.campos[d.id];
    // `false` e resposta ("nao"), como no app e no backend.
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
      falta.push(d.nome || `campo ${d.id}`);
    }
  }
  return falta;
}

function montarBodyCriar(r: Rascunho): Record<string, unknown> {
  const f = r.form!;
  const modo = r.usuario && f.executorId === r.usuario.id ? "eu" : "escolher";
  const campos: Record<string, unknown> = {};
  for (const d of r.camposDef || []) {
    const v = f.campos[d.id];
    if (v === undefined || v === null || v === "") continue;
    campos[d.id] = v;
  }
  return {
    ...(r.threadId ? { threadId: r.threadId } : { messageId: r.messageId }),
    anexosEscolhidos: f.anexos,
    cliente_id: f.clienteId,
    tipo_apontamento_id: f.assuntoId,
    descricao: descricaoFinal(r),
    origem_id: f.origemId,
    setores_vinculados: [f.setorId, ...f.setoresExtra].filter(
      (id, i, todos) => id && todos.indexOf(id) === i,
    ),
    executor_id: f.executorId,
    executor_modo: modo,
    responsavel_conclusao_id: modo === "escolher" ? f.executorId : undefined,
    titulo: f.titulo,
    usuarios_vinculados: f.pessoas,
    campos_personalizados: Object.keys(campos).length ? campos : undefined,
    // Os dois vao sempre, como no app: o padrao da API ja e false.
    finaliza_apontamento: f.finalizado,
    enviar_emails: false,
    // So para o painel de custos.
    usuario: r.usuario?.nome || r.conta,
    cliente_nome: clienteEscolhido(r)?.nome || undefined,
    assunto_nome:
      r.opcoes?.assuntos.find((a) => a.id === f.assuntoId)?.nome || undefined,
  };
}

// ---------------------------------------------------------------------------
// Feedback (mesmo formato do app: renderer/app-feedback.js)
// ---------------------------------------------------------------------------

// Palavras distintas do texto do sistema que ficaram no final (0..1). Copia de
// fracaoPalavrasMantidas do app: o painel /admin compara os dois canais.
function fracaoPalavrasMantidas(original: string, final: string): number | undefined {
  const palavras = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 2),
    );
  const antes = palavras(original);
  if (!antes.size) return undefined;
  const depois = palavras(final);
  let mantidas = 0;
  antes.forEach((w) => {
    if (depois.has(w)) mantidas++;
  });
  return Math.round((mantidas / antes.size) * 100) / 100;
}

async function enviarFeedback(dados: Record<string, unknown>): Promise<void> {
  await chamar(feedbackController, dados);
}

function feedbackImplicito(r: Rascunho): Record<string, unknown> {
  const s = r.sugestao!;
  const f = r.form!;
  const dif = (a?: string, b?: string) => String(a || "") !== String(b || "");
  const sistema = r.corpoSistema || "";
  const editado = f.corpo.trim() !== sistema.trim();
  const modo = r.usuario && f.executorId === r.usuario.id ? "eu" : "escolher";
  return {
    tipo: "implicito",
    origem: "email",
    id: itemDo(r),
    usuario: r.usuario?.nome || r.conta,
    descEditada: editado,
    ...(sistema
      ? {
          descTamSistema: sistema.length,
          descTamFinal: f.corpo.length,
          descPalavrasMantidas: fracaoPalavrasMantidas(sistema, f.corpo),
          descTextoIa: sistema,
          ...(editado ? { descTextoFinal: f.corpo } : {}),
        }
      : {}),
    iaOk: r.preview?.iaOk !== false,
    divergencias: {
      clienteMudou: dif(s.clienteId, f.clienteId),
      clienteTinhaSugestao: !!s.clienteId,
      clienteVia: s.clienteVia,
      setorMudou: dif(s.setorId, f.setorId),
      executorMudou: dif(s.executorId, f.executorId),
      executorModo: modo,
      assuntoSugerido: s.assuntoNome,
      assuntoFinal:
        r.opcoes?.assuntos.find((a) => a.id === f.assuntoId)?.nome || "",
      assuntoMudou: dif(s.assuntoId, f.assuntoId),
      finalizadoSugerido: s.finalizado,
      finalizadoFinal: f.finalizado,
      finalizadoIa: s.finalizado,
    },
  };
}

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

function mensagemParaPessoa(error: unknown, r?: Rascunho): string {
  if (!(error instanceof AppError)) return MSG_INESPERADO;
  if (error.code === "GMAIL_PERFIL_NAO_CONECTADO") return MSG_CONECTAR;
  if (error.code === "SUITE_CAMPOS_OBRIGATORIOS" && isRecord(error.details)) {
    const lista = [
      ...((error.details.faltando as string[]) || []),
      ...((error.details.invalidos as string[]) || []),
    ].map((c) => rotuloCampo(String(c), r?.camposDef));
    if (lista.length) {
      return `O Suite recusou: confira ${[...new Set(lista)].join(", ")}.`;
    }
  }
  return error.message || MSG_INESPERADO;
}

const vermelho = (t: string) => `<font color="#b3261e"><b>${C.esc(t)}</b></font>`;
const laranja = (t: string) => `<font color="#b06000">${C.esc(t)}</font>`;
const cinza = (t: string) => `<font color="#5f6368">${C.esc(t)}</font>`;
const curto = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------------------
// Telas
// ---------------------------------------------------------------------------

function telaMensagem(
  titulo: string,
  texto: string,
  botao?: { texto: string; acao: C.Acao },
) {
  return C.cartao({
    titulo,
    secoes: [{ widgets: [C.paragrafo(C.esc(texto))] }],
    ...(botao ? { botaoPrincipal: botao } : {}),
  });
}

function telaInicio() {
  return C.cartao({
    titulo: "Abrir chamado",
    secoes: [
      {
        widgets: [
          C.paragrafo(
            "Abra um e-mail e clique em <b>Preparar chamado</b>. A IA lê a " +
              "conversa e sugere cliente, assunto e resumo; você confere antes de criar.",
          ),
        ],
      },
    ],
  });
}

function telaGerando(r: Rascunho, ctx: Ctx) {
  return C.cartao({
    titulo: "Preparando o chamado…",
    secoes: [
      {
        widgets: [
          C.paragrafo(
            "A IA ainda está lendo a conversa. Em conversas longas isso passa de " +
              "alguns segundos.",
          ),
          C.paragrafo(cinza("Clique em Atualizar daqui a pouco.")),
        ],
      },
    ],
    botaoPrincipal: {
      texto: "Atualizar",
      acao: C.acao(ctx.url("atualizar"), { rascunho: r.id }),
    },
  });
}

function itensCom(opcoes: Opcao[], selecionado: string, comVazio = true): C.ItemLista[] {
  const itens: C.ItemLista[] = opcoes.map((o) => ({
    texto: curto(o.cnpj ? `${o.nome} — ${o.cnpj}` : o.nome, 90),
    valor: o.id,
    selecionado: o.id === selecionado,
  }));
  // Item vazio: sem ele o Google seleciona o primeiro da lista sozinho, e um
  // cliente que ninguem escolheu iria para o chamado.
  return comVazio
    ? [{ texto: "— selecione —", valor: "", selecionado: !selecionado }, ...itens]
    : itens;
}

async function telaRevisao(r: Rascunho, ctx: Ctx, aviso?: string) {
  const p = r.preview!;
  const f = r.form!;
  const [setores, origens] = await Promise.all([
    listaSetores().catch(() => [] as Opcao[]),
    listaOrigens().catch(() => [] as Opcao[]),
  ]);
  // Lista do Suite fora do ar: mantem ao menos o que ja estava escolhido, para
  // a pessoa nao perder a escolha por causa de uma consulta.
  const comEscolhido = (lista: Opcao[], id: string) =>
    !id || lista.some((o) => o.id === id) ? lista : [{ id, nome: id }, ...lista];
  const param = { rascunho: r.id };
  const buscar = (alvo: string) =>
    C.acao(ctx.url("buscar"), { rascunho: r.id, alvo });

  const topo: C.Widget[] = [];
  if (aviso) topo.push(C.paragrafo(vermelho(aviso)));
  if (!p.iaOk) {
    topo.push(
      C.paragrafo(
        laranja(
          "A IA não gerou o resumo automático. Confira e preencha a descrição.",
        ),
      ),
    );
  }
  if (p.dryRun || ctx.simular) {
    topo.push(C.paragrafo(laranja("Envio simulado: nada vai para o Suite.")));
  }
  topo.push(C.rotuloValor("De", p.email.de));

  const chamado: C.Widget[] = [
    C.campoTexto({ nome: "titulo", rotulo: "Título", valor: f.titulo }),
    C.lista({
      nome: "cliente",
      rotulo: "Cliente",
      itens: itensCom(r.opcoes!.clientes, f.clienteId),
    }),
    C.campoTexto({ nome: "busca_cliente", rotulo: "Buscar cliente", dica: "Nome ou CNPJ" }),
    C.botoes([{ texto: "Buscar cliente", acao: buscar("cliente") }]),
    C.lista({
      nome: "assunto",
      rotulo: "Assunto",
      itens: itensCom(r.opcoes!.assuntos, f.assuntoId),
      aoMudar: C.acao(ctx.url("assunto"), param),
    }),
    C.campoTexto({ nome: "busca_assunto", rotulo: "Buscar assunto" }),
    C.botoes([{ texto: "Buscar assunto", acao: buscar("assunto") }]),
    C.lista({
      nome: "origem",
      rotulo: "Origem",
      itens: itensCom(comEscolhido(origens, f.origemId), f.origemId),
    }),
    C.lista({
      nome: "setor",
      rotulo: "Setor",
      itens: itensCom(comEscolhido(setores, f.setorId), f.setorId),
    }),
    C.lista({
      nome: "executor",
      rotulo: "Executor",
      itens: itensCom(r.opcoes!.executores, f.executorId),
    }),
    C.campoTexto({ nome: "busca_executor", rotulo: "Buscar executor" }),
    C.botoes([{ texto: "Buscar executor", acao: buscar("executor") }]),
    C.interruptor({
      nome: "finalizado",
      rotulo: "Criar já finalizado",
      ligado: f.finalizado,
      descricao:
        r.sugestao?.finalizado && r.sugestao.finalizadoMotivo
          ? curto(`Sugerido pela IA: ${r.sugestao.finalizadoMotivo}`, 140)
          : "Ligado, o chamado nasce fechado: ninguém vai trabalhar nele depois.",
    }),
  ];

  const campos: C.Widget[] = (r.camposDef || []).map((d) => {
    const nome = `cp_${d.id}`;
    const rotulo = `${d.nome || `Campo ${d.id}`}${d.obrigatorio ? " *" : ""}`;
    const v = f.campos[d.id];
    if (d.tipo === "booleano") {
      return C.interruptor({ nome, rotulo, ligado: v === true });
    }
    if (d.tipo === "data") {
      return C.campoData({ nome, rotulo, valorIso: typeof v === "string" ? v : "" });
    }
    // Tipo desconhecido cai em texto de proposito (mesma regra do app):
    // sumir com o campo faria o Suite recusar sem a pessoa entender por que.
    return C.campoTexto({ nome, rotulo, valor: typeof v === "string" ? v : "" });
  });

  const vinculos: C.Widget[] = [];
  const extras = extrasDeSetor(r);
  if (extras.length) {
    vinculos.push(
      C.lista({
        nome: "setores_extra",
        rotulo: "Setores vinculados (sugeridos pela IA)",
        tipo: "CHECK_BOX",
        itens: extras.map((s) => ({
          texto: s.nome,
          valor: s.id,
          selecionado: f.setoresExtra.includes(s.id),
        })),
      }),
    );
  }
  if (p.pessoasSugeridas.length) {
    vinculos.push(
      C.lista({
        nome: "pessoas",
        rotulo: "Pessoas vinculadas (sugeridas pela IA)",
        tipo: "CHECK_BOX",
        itens: p.pessoasSugeridas.map((s) => ({
          texto: s.nome,
          valor: s.id,
          selecionado: f.pessoas.includes(s.id),
        })),
      }),
    );
  }

  const anexos: C.Widget[] = [];
  const liberados = p.anexos.filter((a) => !a.bloqueado);
  if (liberados.length) {
    anexos.push(
      C.lista({
        nome: "anexos",
        rotulo: "Anexar ao chamado",
        tipo: "CHECK_BOX",
        itens: liberados.map((a) => ({
          texto: curto(`${a.nome} (${a.tamanhoTexto})`, 90),
          valor: a.id,
          selecionado: f.anexos.includes(a.id),
        })),
      }),
    );
  }
  for (const a of p.anexos.filter((x) => x.bloqueado)) {
    anexos.push(C.paragrafo(cinza(`${a.nome}: não pode ir (${a.motivo}).`)));
  }

  return C.cartao({
    titulo: "Revisar chamado",
    subtitulo: curto(p.email.assunto || "(sem assunto)"),
    secoes: [
      { widgets: topo },
      { titulo: "Chamado", widgets: chamado },
      { titulo: "Campos do assunto", widgets: campos },
      { titulo: "Também vincular", widgets: vinculos },
      {
        titulo: "Descrição",
        widgets: [
          C.paragrafo(
            cinza(
              "O cabeçalho com cliente e dados do e-mail entra sozinho; edite só o resumo.",
            ),
          ),
          C.campoTexto({
            nome: "descricao",
            rotulo: "Resumo",
            valor: f.corpo,
            multilinha: true,
          }),
        ],
      },
      { titulo: "Anexos", widgets: anexos },
    ],
    botaoPrincipal: {
      texto: ctx.simular ? "Simular criação" : "Criar chamado",
      acao: C.acao(ctx.url("criar"), param),
    },
  });
}

function telaCriado(r: Rascunho, ctx: Ctx) {
  const c = r.criado!;
  const titulo = c.dryRun
    ? "Chamado simulado"
    : c.jaExistia
      ? "Este e-mail já tinha chamado"
      : "Chamado criado";
  const widgets: C.Widget[] = [
    C.paragrafo(
      c.protocolo
        ? `Protocolo <b>${C.esc(c.protocolo)}</b>`
        : c.dryRun
          ? "Nada foi enviado ao Suite (modo simulação)."
          : "Criado no Suite.",
    ),
    ...c.avisos.map((a) => C.paragrafo(laranja(a))),
  ];

  const secoes: C.Secao[] = [{ widgets }];
  // Feedback so em criacao real e nova, como no app. Nunca obrigatorio.
  if (!c.dryRun && !c.jaExistia) {
    const fb: C.Widget[] = [];
    if (c.feedback === "up" || c.feedback === "down") {
      fb.push(C.paragrafo(cinza("Obrigado pelo feedback!")));
    } else if (c.feedback === "abrindo") {
      fb.push(
        C.lista({
          nome: "tags",
          rotulo: "O que errou?",
          tipo: "CHECK_BOX",
          itens: [
            "Resumo incorreto/incompleto",
            "Cliente errado",
            "Assunto errado",
            "Faltou providência",
            "Outro",
          ].map((t) => ({ texto: t, valor: t })),
        }),
        C.campoTexto({
          nome: "comentario",
          rotulo: "Comentário (opcional)",
          multilinha: true,
        }),
        C.botoes([
          {
            texto: "Enviar feedback",
            acao: C.acao(ctx.url("feedback"), { rascunho: r.id, nota: "enviar" }),
          },
        ]),
      );
    } else {
      fb.push(
        C.paragrafo("O que a IA sugeriu (resumo, cliente, assunto) ajudou?"),
        C.botoes([
          {
            texto: "Ajudou",
            acao: C.acao(ctx.url("feedback"), { rascunho: r.id, nota: "up" }),
          },
          {
            texto: "Precisa melhorar",
            acao: C.acao(ctx.url("feedback"), { rascunho: r.id, nota: "down" }),
          },
        ]),
      );
    }
    secoes.push({ titulo: "Feedback", widgets: fb });
  }
  return C.cartao({ titulo, secoes });
}

// O `?simular=1` da URL de teste: mostra o que IRIA para o Suite, sem criar.
// Existe para o primeiro teste rodar contra o servidor de producao (que cria
// chamado de verdade) sem gerar chamado nenhum.
function telaSimulada(r: Rascunho, ctx: Ctx) {
  const { chamado, avisos } = montarChamadoBodyDaRequisicao(montarBodyCriar(r));
  const { faltando: falta, invalidos } = validarChamadoBody(chamado);
  const nomeDe = (lista: Opcao[] | undefined, id: unknown) =>
    lista?.find((o) => o.id === String(id ?? ""))?.nome || String(id ?? "-");
  const widgets: C.Widget[] = [
    C.paragrafo(laranja("Simulação: nada foi enviado ao Suite.")),
    C.rotuloValor("Cliente", nomeDe(r.opcoes?.clientes, chamado.cliente_id)),
    C.rotuloValor("Assunto", nomeDe(r.opcoes?.assuntos, chamado.tipo_apontamento_id)),
    C.rotuloValor("Executor", nomeDe(r.opcoes?.executores, chamado.executor_id)),
    C.rotuloValor("Setores (ids)", (chamado.setores_vinculados || []).join(", ")),
    C.rotuloValor("Finalizado", chamado.finaliza_apontamento ? "sim" : "não"),
    C.rotuloValor("Anexos", String(r.form?.anexos.length || 0)),
    C.rotuloValor("Descrição", curto(String(chamado.descricao || ""), 600)),
  ];
  const problemas = [...falta, ...invalidos].map((x) => rotuloCampo(x, r.camposDef));
  if (problemas.length) {
    widgets.push(C.paragrafo(vermelho(`O Suite recusaria: ${problemas.join(", ")}.`)));
  }
  for (const a of avisos) widgets.push(C.paragrafo(laranja(a)));
  return C.cartao({
    titulo: "Chamado simulado",
    secoes: [{ widgets }],
    botaoPrincipal: {
      texto: "Voltar à revisão",
      acao: C.acao(ctx.url("atualizar"), { rascunho: r.id }),
    },
  });
}

async function telaDoRascunho(r: Rascunho, ctx: Ctx) {
  if (r.criado) return telaCriado(r, ctx);
  if (r.status === "pronto") return telaRevisao(r, ctx);
  const preparar = {
    texto: "Tentar de novo",
    acao: C.acao(ctx.url("preparar"), {
      threadId: r.threadId,
      messageId: r.messageId,
    }),
  };
  if (r.status === "erro") {
    return telaMensagem("Não foi possível preparar", r.erro || MSG_INESPERADO, preparar);
  }
  if (Date.now() - r.iniciadoEm > PREVIEW_ABANDONADO_MS) {
    return telaMensagem(
      "A preparação não terminou",
      "A leitura do e-mail parou no meio. Tente de novo.",
      preparar,
    );
  }
  return telaGerando(r, ctx);
}

// ---------------------------------------------------------------------------
// Acoes
// ---------------------------------------------------------------------------

function idsDoEvento(evento: unknown): { threadId: string; messageId: string } {
  const g = isRecord(evento) && isRecord(evento.gmail) ? evento.gmail : {};
  return {
    threadId: typeof g.threadId === "string" ? g.threadId : "",
    messageId: typeof g.messageId === "string" ? g.messageId : "",
  };
}

async function contaConectada(conta: string): Promise<boolean> {
  try {
    await resolverContaGoogle("", conta);
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === "GMAIL_PERFIL_NAO_CONECTADO") {
      return false;
    }
    throw error;
  }
}

// Tela inicial (Gmail aberto, nenhum e-mail selecionado).
async function acaoInicio(ctx: Ctx) {
  if (!(await contaConectada(ctx.conta))) {
    return C.resposta.empurrar(telaMensagem("Conecte sua conta", MSG_CONECTAR));
  }
  return C.resposta.empurrar(telaInicio());
}

// E-mail aberto: nada de IA aqui (abrir e-mail nao pode custar dinheiro); so
// mostra se ja tem chamado, se ha revisao em andamento ou o botao de preparar.
async function acaoEmail(ctx: Ctx) {
  const { threadId, messageId } = idsDoEvento(ctx.evento);
  if (!threadId && !messageId) return C.resposta.empurrar(telaInicio());
  if (!(await contaConectada(ctx.conta))) {
    return C.resposta.empurrar(telaMensagem("Conecte sua conta", MSG_CONECTAR));
  }

  // Thread = 1 chamado (regra do app). O messageId cobre quem usou "Separar
  // mensagens" no desktop.
  const item = threadId || messageId;
  const ja =
    (await getChamadoCriado(item, "gmail").catch(() => null)) ||
    (threadId && messageId
      ? await getChamadoCriado(messageId, "gmail").catch(() => null)
      : null);
  if (ja) {
    return C.resposta.empurrar(
      telaMensagem(
        "Este e-mail já tem chamado",
        ja.protocolo ? `Protocolo ${ja.protocolo}.` : "O chamado já foi criado.",
      ),
    );
  }

  const idRasc = await cacheGet<string>(chaveItem(ctx.conta, item)).catch(() => null);
  const r = idRasc ? await cacheGet<Rascunho>(chaveRascunho(idRasc)).catch(() => null) : null;
  if (r && r.conta === ctx.conta && r.status !== "erro" && !r.criado) {
    return C.resposta.empurrar(await telaDoRascunho(r, ctx));
  }

  return C.resposta.empurrar(
    C.cartao({
      titulo: "Abrir chamado",
      secoes: [
        {
          widgets: [
            C.paragrafo(
              "A IA lê esta conversa e sugere cliente, assunto e resumo. Você " +
                "confere tudo antes de criar.",
            ),
          ],
        },
      ],
      botaoPrincipal: {
        texto: "Preparar chamado",
        acao: C.acao(ctx.url("preparar"), { threadId, messageId }),
      },
    }),
  );
}

async function acaoPreparar(ctx: Ctx) {
  const threadId = C.lerParametro(ctx.evento, "threadId");
  const messageId = C.lerParametro(ctx.evento, "messageId");
  if (!threadId && !messageId) {
    throw new AppError({
      statusCode: 400,
      code: "MESSAGE_ID_REQUIRED",
      message: "Abra um e-mail para preparar o chamado.",
    });
  }
  const item = threadId || messageId;

  // Reabrir o mesmo e-mail reaproveita a revisao: cada preparo e uma chamada
  // de IA paga.
  const idExistente = await cacheGet<string>(chaveItem(ctx.conta, item)).catch(() => null);
  const existente = idExistente
    ? await cacheGet<Rascunho>(chaveRascunho(idExistente)).catch(() => null)
    : null;
  const abandonado =
    existente?.status === "gerando" &&
    Date.now() - existente.iniciadoEm > PREVIEW_ABANDONADO_MS;
  if (
    existente &&
    existente.conta === ctx.conta &&
    existente.status !== "erro" &&
    !existente.criado &&
    !abandonado
  ) {
    return C.resposta.atualizar(await telaDoRascunho(existente, ctx));
  }

  const r: Rascunho = {
    id: randomUUID(),
    conta: ctx.conta,
    threadId,
    messageId,
    status: "gerando",
    iniciadoEm: Date.now(),
    simular: ctx.simular,
  };
  await salvarRascunho(r);
  await cacheSet(chaveItem(ctx.conta, item), r.id, TTL_RASCUNHO_SEG);

  const tarefa = gerarRascunho(r);
  if (!(await terminouEm(tarefa, ESPERA_PREVIEW_MS))) {
    emSegundoPlano(tarefa);
    return C.resposta.atualizar(telaGerando(r, ctx));
  }
  return C.resposta.atualizar(await telaDoRascunho(r, ctx));
}

async function acaoAtualizar(ctx: Ctx) {
  const r = await lerRascunho(C.lerParametro(ctx.evento, "rascunho"), ctx.conta);
  return C.resposta.atualizar(await telaDoRascunho(r, ctx));
}

async function acaoBuscar(ctx: Ctx) {
  const r = await lerRascunho(C.lerParametro(ctx.evento, "rascunho"), ctx.conta);
  if (r.status !== "pronto" || r.criado) {
    return C.resposta.atualizar(await telaDoRascunho(r, ctx));
  }
  absorverFormulario(r, ctx.evento);
  const alvo = C.lerParametro(ctx.evento, "alvo");
  const termo = C.lerCampo(ctx.evento, `busca_${alvo}`);
  if (!termo) {
    return C.resposta.atualizar(
      await telaRevisao(r, ctx, "Digite o que buscar antes de clicar em Buscar."),
    );
  }

  if (!["cliente", "assunto", "executor"].includes(alvo)) {
    throw new AppError({ statusCode: 400, code: "ADDON_ALVO_INVALIDO", message: MSG_INESPERADO });
  }

  let achados: Opcao[] = [];
  try {
    if (alvo === "cliente") {
      const digitos = termo.replace(/\D+/g, "");
      // Mesma regra do app: 11+ digitos e CPF/CNPJ, o resto e nome.
      const lista = await buscarClientes(
        digitos.length >= 11 ? { cnpj: digitos } : { q: termo },
      );
      achados = lista
        .filter((c) => c.id)
        .map((c) => ({ id: String(c.id), nome: c.razao_social || String(c.id), cnpj: c.cnpj }));
    } else if (alvo === "assunto") {
      achados = (await buscarTipos(termo))
        .filter((t) => t.id)
        .map((t) => ({ id: String(t.id), nome: t.extra ? `${t.nome} (${t.extra})` : t.nome }));
    } else {
      achados = (await buscarUsuarios(termo)).itens
        .filter((u) => u.id)
        .map((u) => ({ id: String(u.id), nome: u.nome }));
    }
  } catch (error) {
    // A busca falhar nao pode jogar fora o que a pessoa ja preencheu: o aviso
    // aparece na propria revisao.
    console.warn(
      `[addon:gmail:buscar] rasc=${r.id} busca de ${alvo} falhou: ${getErrorMessage(error)}`,
    );
    await salvarRascunho(r);
    return C.resposta.atualizar(
      await telaRevisao(r, ctx, `Não consegui buscar no Suite agora: ${mensagemParaPessoa(error)}`),
    );
  }

  const chave = alvo === "cliente" ? "clientes" : alvo === "assunto" ? "assuntos" : "executores";
  const campoForm = alvo === "cliente" ? "clienteId" : alvo === "assunto" ? "assuntoId" : "executorId";
  const atual = r.opcoes![chave].find((o) => o.id === r.form![campoForm]);
  // O escolhido continua na lista: buscar nao pode desfazer a escolha.
  r.opcoes![chave] = [
    ...(atual && !achados.some((a) => a.id === atual.id) ? [atual] : []),
    ...achados.slice(0, MAX_OPCOES),
  ];
  await salvarRascunho(r);

  const aviso = !achados.length
    ? `Nada encontrado para "${curto(termo, 40)}".`
    : achados.length > MAX_OPCOES
      ? `Mostrando ${MAX_OPCOES} de ${achados.length}. Refine a busca se não achar.`
      : undefined;
  return C.resposta.atualizar(await telaRevisao(r, ctx, aviso));
}

// Trocar o assunto troca os campos personalizados que o Suite exige.
async function acaoAssunto(ctx: Ctx) {
  const r = await lerRascunho(C.lerParametro(ctx.evento, "rascunho"), ctx.conta);
  if (r.status !== "pronto" || r.criado) {
    return C.resposta.atualizar(await telaDoRascunho(r, ctx));
  }
  absorverFormulario(r, ctx.evento);
  let aviso: string | undefined;
  try {
    r.camposDef = r.form!.assuntoId ? await buscarCamposDoTipo(r.form!.assuntoId) : [];
  } catch (error) {
    console.warn(
      `[addon:gmail:assunto] rasc=${r.id} campos do assunto falharam: ${getErrorMessage(error)}`,
    );
    r.camposDef = [];
    aviso =
      "Não consegui carregar os campos deste assunto. O Suite pode recusar se faltar algum.";
  }
  await salvarRascunho(r);
  return C.resposta.atualizar(await telaRevisao(r, ctx, aviso));
}

async function acaoCriar(ctx: Ctx) {
  const r = await lerRascunho(C.lerParametro(ctx.evento, "rascunho"), ctx.conta);
  if (r.criado || r.status !== "pronto") {
    return C.resposta.atualizar(await telaDoRascunho(r, ctx));
  }
  absorverFormulario(r, ctx.evento);
  await salvarRascunho(r);

  if (ctx.simular) return C.resposta.empurrar(telaSimulada(r, ctx));

  const falta = faltando(r);
  // Em dry-run o backend aceita incompleto e devolve o que falta (igual ao app).
  if (falta.length && !r.preview!.dryRun) {
    return C.resposta.atualizar(
      await telaRevisao(r, ctx, `Ainda falta preencher: ${falta.join(", ")}.`),
    );
  }

  // O criar do desktop baixa os anexos e tira o marcador com a conta que o
  // preview guardou (gmail:acct:<item>, 6 h). Aqui a revisao pode passar disso,
  // e o rascunho ja diz de quem e o e-mail: regrava antes de criar.
  await salvarContaDoEmail(itemDo(r), r.conta).catch((error) =>
    console.warn(`[addon:gmail:criar] rasc=${r.id} conta do item nao regravada: ${getErrorMessage(error)}`),
  );

  let d: Record<string, any>;
  try {
    const { corpo } = await chamar(gmailCriarController, montarBodyCriar(r));
    d = isRecord(corpo.data) ? (corpo.data as Record<string, any>) : {};
  } catch (error) {
    console.error(
      `[addon:gmail:criar] rasc=${r.id} conta=${r.conta} item=${itemDo(r)} falhou: ` +
        `${error instanceof AppError ? error.code : "sem code"} ${getErrorMessage(error)}`,
    );
    return C.resposta.atualizar(await telaRevisao(r, ctx, mensagemParaPessoa(error, r)));
  }

  // Dry-run incompleto nao e criacao: volta para a revisao com o que falta,
  // como o "Simular novamente" do app.
  const pendentes = [
    ...(Array.isArray(d.faltando) ? d.faltando : []),
    ...(Array.isArray(d.invalidos) ? d.invalidos : []),
  ].map((c: unknown) => rotuloCampo(String(c), r.camposDef));
  if (d.dryRun && pendentes.length) {
    return C.resposta.atualizar(
      await telaRevisao(r, ctx, `Simulado. Para criar de verdade, falta: ${[...new Set(pendentes)].join(", ")}.`),
    );
  }

  const protocolos: string[] = Array.isArray(d.protocolos) ? d.protocolos : [];
  r.criado = {
    protocolo: protocolos.length > 1 ? protocolos.join(", ") : String(d.protocolo || ""),
    jaExistia: !!d.jaExistia,
    dryRun: !!d.dryRun,
    avisos: Array.isArray(d.avisos) ? d.avisos.filter(Boolean).map(String) : [],
  };
  await salvarRascunho(r);
  console.log(
    `[addon:gmail:criar] rasc=${r.id} conta=${r.conta} item=${itemDo(r)} ` +
      `protocolo=${r.criado.protocolo || "-"} jaExistia=${r.criado.jaExistia} dryRun=${r.criado.dryRun}`,
  );

  if (!r.criado.dryRun) {
    // Lembra o setor para o proximo chamado (o "perfil" do painel).
    await cacheSet(chavePerfil(r.conta), { setorId: r.form!.setorId }, TTL_PERFIL_SEG).catch(
      (error) =>
        console.warn(`[addon:gmail:criar] perfil nao salvo: ${getErrorMessage(error)}`),
    );
  }
  if (!r.criado.dryRun && !r.criado.jaExistia) {
    await enviarFeedback(feedbackImplicito(r)).catch((error) =>
      console.warn(
        `[addon:gmail:criar] rasc=${r.id} feedback implicito nao gravado: ${getErrorMessage(error)}`,
      ),
    );
  }
  return C.resposta.atualizar(telaCriado(r, ctx));
}

async function acaoFeedback(ctx: Ctx) {
  const r = await lerRascunho(C.lerParametro(ctx.evento, "rascunho"), ctx.conta);
  if (!r.criado) return C.resposta.atualizar(await telaDoRascunho(r, ctx));
  const nota = C.lerParametro(ctx.evento, "nota");

  if (nota === "down") {
    // 👎 abre os detalhes em vez de enviar: e no "o que errou" que esta a
    // informacao util para corrigir o prompt (mesma decisao do app).
    r.criado.feedback = "abrindo";
    await salvarRascunho(r);
    return C.resposta.atualizar(telaCriado(r, ctx));
  }

  const rating = nota === "up" ? "up" : "down";
  await enviarFeedback({
    tipo: "explicito",
    origem: "email",
    id: itemDo(r),
    usuario: r.usuario?.nome || r.conta,
    rating,
    tags: rating === "down" ? C.lerLista(ctx.evento, "tags") : [],
    comentario: rating === "down" ? C.lerCampo(ctx.evento, "comentario") : "",
    descEditada: (r.form?.corpo || "").trim() !== (r.corpoSistema || "").trim(),
  });
  r.criado.feedback = rating;
  await salvarRascunho(r);
  return C.resposta.atualizar(telaCriado(r, ctx));
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

const ACOES: Record<string, (ctx: Ctx) => Promise<unknown>> = {
  inicio: acaoInicio,
  email: acaoEmail,
  preparar: acaoPreparar,
  atualizar: acaoAtualizar,
  buscar: acaoBuscar,
  assunto: acaoAssunto,
  criar: acaoCriar,
  feedback: acaoFeedback,
};

// POST /api/addon/gmail/:acao — toda tela e todo clique do painel.
//
// Sempre responde um cartao, inclusive no erro: o Google mostra so "nao foi
// possivel carregar" para qualquer resposta fora do formato, e a pessoa nao
// saberia o que aconteceu. A excecao e pedido que nao provou vir do Google:
// esse leva 401 sem cartao.
export async function gmailAddonController(req: Request, res: Response) {
  const nome = String(req.params.acao || "");
  const acao = ACOES[nome];
  if (!acao) {
    res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "Ação desconhecida." } });
    return;
  }

  let conta: string;
  try {
    conta = await identificar(req);
  } catch (error) {
    const e = error instanceof AppError ? error : null;
    console.warn(
      `[addon:gmail:${nome}] identidade recusada: ${e?.code || "sem code"} ` +
        `${JSON.stringify(e?.details ?? getErrorMessage(error))}`,
    );
    if (e?.code === "ADDON_TOKEN_INVALIDO") {
      res.status(401).json({ ok: false, error: { code: e.code, message: e.message } });
      return;
    }
    res
      .status(200)
      .json(C.resposta.empurrar(telaMensagem("Não foi possível abrir o painel", e?.message || MSG_INESPERADO)));
    return;
  }

  const simular = req.query.simular === "1";
  const base = urlBase(req);
  const ctx: Ctx = {
    evento: req.body,
    conta,
    simular,
    url: (a) => `${base}${PREFIXO_ROTAS}${a}${simular ? "?simular=1" : ""}`,
  };

  try {
    res.status(200).json(await acao(ctx));
  } catch (error) {
    console.error(
      `[addon:gmail:${nome}] conta=${conta} falhou: ` +
        `${error instanceof AppError ? error.code : "sem code"} ${getErrorMessage(error)}`,
    );
    res
      .status(200)
      .json(C.resposta.empurrar(telaMensagem("Algo deu errado", mensagemParaPessoa(error))));
  }
}
