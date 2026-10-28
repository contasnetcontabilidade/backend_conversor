// Painel do Gmail (complemento do Google Workspace): abrir chamado sem sair do
// e-mail. PILOTO.
//
// O painel faz o mesmo que a aba E-mails do desktop e chama os MESMOS
// controllers de preview e de criacao (gmail.controller). Assim as regras ja
// validadas (idempotencia, anexos conferidos no Gmail, marcador removido, custo
// e falhas no /admin) valem aqui sem copia, e os dois caminhos nao divergem.
//
// A tela de revisao segue o formulario "Abrir chamado" do app
// (renderer/app-revisao.js) campo a campo: varias empresas, setores e pessoas
// vinculadas, "Todo o setor", competencia, prioridade, prazo, visibilidade,
// interno, e-mails, processos, campos do assunto, regenerar resumo e feedback.
// Mudou algo la? Confira se precisa mudar aqui.
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
//  - Nao ha pre-visualizacao de anexo nem "conteudo" separado: o e-mail esta
//    aberto ao lado do painel.

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
import { gerarResumoGemini } from "../services/gemini";
import { publishAbrirEmail } from "../services/ably";
import { listarMensagensDaThread, type MensagemDaThread } from "../services/gmailApi";
import { ensureBodyObject, getOptionalString } from "../utils/request";
import {
  buscarCamposDoTipo,
  buscarClientes,
  buscarOrigens,
  buscarProcessos,
  buscarSetores,
  buscarTipos,
  buscarUsuarios,
  montarDescricaoEmail,
  validarChamadoBody,
  type CampoPersonalizado,
  type ItemLista,
} from "../services/suite360";
import { competenciaAtual, hojeSaoPaulo } from "../utils/datas";
import * as C from "../services/gmailAddonCards";

const TTL_RASCUNHO_SEG = 6 * 3600;
const TTL_PERFIL_SEG = 180 * 24 * 3600;
const TTL_USUARIO_SEG = 3600;
const TTL_USUARIO_AUSENTE_SEG = 600;
const TTL_LISTA_SEG = 600;
// Quanto esperar a IA antes de responder "Preparando… Atualizar". O Google
// corta muito antes dos 30 s que a documentacao sugere, e nao publica o
// numero: no teste real de 28/10/2026 o Gmail deu 504 ("Tempo limite ao
// receber o conteudo HTTP") esperando 20 s, e de novo esperando 8 s. Somando o
// arranque a frio da Vercel, nenhuma resposta do painel pode depender da IA.
const ESPERA_PREVIEW_MS = 3_000;
const ESPERA_REGENERAR_MS = 3_000;
// O "Atualizar" espera um pouco a IA terminar antes de responder, para a
// pessoa nao precisar clicar varias vezes — com o mesmo teto curto.
const ESPERA_ATUALIZAR_MS = 3_000;
// Teto de qualquer resposta do painel. Passou disso, o servidor responde "tente
// de novo" em vez de deixar o Google dar 504, e o que estava em andamento
// termina em segundo plano. As esperas acima cabem nele com folga.
const ORCAMENTO_RESPOSTA_MS = 4_500;
// Ler a lista de e-mails da conversa (para escolher qual vira chamado) tem um
// teto proprio: passou disso, o painel mostra so o "Abrir no app" da conversa.
const ESPERA_LISTA_CONVERSA_MS = 2_500;
// Guarda a lista por pouco tempo: o cartao do e-mail e pedido de novo a cada
// vez que a pessoa volta nele, e e-mail novo na conversa aparece em ate 1 min.
const TTL_LISTA_CONVERSA_SEG = 60;
// E-mails listados para escolher. Conversa maior mostra os mais recentes.
const MAX_EMAILS_ESCOLHA = 15;
// Formato do rascunho. Rascunho de outra versao (de um deploy anterior) e
// tratado como vencido: ler um formato velho quebraria a tela.
const VERSAO_RASCUNHO = 2;
// Preparacao "gerando" ha mais que isto morreu no caminho (a funcao da Vercel
// caiu, por exemplo): a tela deixa tentar de novo em vez de esperar para sempre.
const PREVIEW_ABANDONADO_MS = 4 * 60_000;
// Itens numa lista de escolha. Busca devolve mais? A tela pede para refinar.
const MAX_OPCOES = 50;
// Conteudo do e-mail guardado no rascunho (para regenerar o resumo e para a
// secao "Conteudo do e-mail"). Thread enorme nao pode estourar o Redis.
const MAX_CONTEUDO = 60_000;
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
  extra?: string;
}

interface UsuarioSuite {
  id: string;
  nome: string;
  setorIds: string[];
}

type ModoEmpresas = "independente" | "agrupado_sincronizado";

interface FormRascunho {
  titulo: string;
  clienteId: string;
  empresas: Opcao[]; // outras empresas, alem do cliente principal
  modoEmpresas: ModoEmpresas;
  assuntoId: string;
  origemId: string;
  setorId: string;
  setoresExtra: Opcao[];
  executorId: string;
  pessoas: Opcao[];
  // Quem entrou pelo "Todo o setor": o segundo clique (e a troca de setor) tira
  // SO essa gente — quem a IA sugeriu, quem foi adicionado a mao e o executor
  // ficam. Mesma regra do app (usuariosAutoSetor).
  pessoasDoSetor: string[];
  processos: Opcao[];
  competencia: string; // AAAA-MM
  prioridade: string; // "" = padrao do Suite
  prazo: string; // AAAA-MM-DD
  visibilidade: "publico" | "restrito";
  interno: boolean;
  enviarEmails: boolean;
  finalizado: boolean;
  corpo: string; // so a parte editavel da descricao (ver partesDescricao)
  anexos: string[];
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
  conteudo: string;
  anexos: Array<{
    id: string;
    nome: string;
    tamanhoTexto: string;
    bloqueado: boolean;
    motivo: string;
  }>;
  // O que a IA citou e o Suite nao reconheceu: aparece para a pessoa decidir.
  naoResolvidos: string[];
}

interface Rascunho {
  versao: number;
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
  camposFalharam?: boolean;
  // Campo/lista que a pessoa esta mexendo agora (so ele abre busca ou lista)
  // e o que aparece para escolher.
  editando?: string;
  resultados?: Opcao[];
  resultadosTotal?: number;
  // Feedback do resumo dado ainda na revisao (o "O resumo ficou bom?" do app).
  feedbackRevisao?: "up" | "down" | "abrindo";
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
    interno: boolean;
    internoFonte: string;
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
//
// No Chat (`usuarioDoChat`), o evento traz quem acionou em `chat.user.email`.
// Sem userIdToken, vale esse e-mail — mas SO depois de o token de sistema provar
// que o evento veio do Google para este complemento.
export async function identificar(
  req: Request,
  opts: { usuarioDoChat?: boolean } = {},
): Promise<string> {
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
  const chat = isRecord(evento.chat) ? evento.chat : {};
  const userChat = isRecord(chat.user) ? chat.user : {};
  const emailDoChat =
    opts.usuarioDoChat && !tokenUsuario && typeof userChat.email === "string"
      ? userChat.email
      : "";
  const usuario = emailDoChat
    ? { email: emailDoChat, email_verified: true }
    : await verificarIdTokenGoogle(tokenUsuario, {
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
// Em qual ramal esta o app desktop desta conta Google (o app grava ao iniciar).
// Vale para o Gmail e para o Chat: a conta e a mesma.
const chaveRamalDaConta = (conta: string) => `addon:gmail:ramal:${conta}`;
export async function ramalDaConta(conta: string): Promise<string> {
  const r = await cacheGet<string>(chaveRamalDaConta(conta)).catch(() => null);
  return r ? String(r) : "";
}
const TTL_RAMAL_SEG = 180 * 24 * 3600;
const itemDo = (r: { threadId: string; messageId: string }) =>
  r.threadId || r.messageId;

async function salvarRascunho(r: Rascunho): Promise<void> {
  await cacheSet(chaveRascunho(r.id), r, TTL_RASCUNHO_SEG);
}

// Rascunho desta conta e deste formato, ou null. A conta confere de proposito:
// o id do rascunho viaja no cartao.
async function rascunhoValido(id: string | null, conta: string): Promise<Rascunho | null> {
  const r = id ? await cacheGet<Rascunho>(chaveRascunho(id)).catch(() => null) : null;
  return r && r.conta === conta && r.versao === VERSAO_RASCUNHO ? r : null;
}

async function lerRascunho(id: string, conta: string): Promise<Rascunho> {
  const r = await rascunhoValido(id, conta);
  if (!r) {
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

const paraOpcao = (i: ItemLista): Opcao => ({
  id: String(i.id),
  nome: i.nome || String(i.id),
  ...(i.extra ? { extra: i.extra } : {}),
});

async function listaCacheada(
  chave: string,
  buscar: () => Promise<ItemLista[]>,
): Promise<Opcao[]> {
  const cache = await cacheGet<Opcao[]>(chave).catch(() => null);
  if (Array.isArray(cache) && cache.length) return cache;
  const itens = (await buscar()).filter((i) => i.id).map(paraOpcao);
  await cacheSet(chave, itens, TTL_LISTA_SEG).catch(() => undefined);
  return itens;
}

const listaSetores = () => listaCacheada("addon:lista:setores", buscarSetores);
const listaOrigens = () => listaCacheada("addon:lista:origens", buscarOrigens);

// Pessoas de um setor. Vazio quando o Suite nao conseguiu filtrar: ai a base
// inteira viria junto, e o app tambem nao despeja ninguem nesse caso.
async function pessoasDoSetor(setorId: string): Promise<Opcao[]> {
  if (!setorId) return [];
  const chave = `addon:lista:pessoas-setor:${setorId}`;
  const cache = await cacheGet<Opcao[]>(chave).catch(() => null);
  if (Array.isArray(cache)) return cache;
  const { itens, filtradoPorSetor } = await buscarUsuarios(undefined, setorId);
  const lista = filtradoPorSetor === false ? [] : itens.filter((u) => u.id).map(paraOpcao);
  await cacheSet(chave, lista, TTL_LISTA_SEG).catch(() => undefined);
  return lista;
}

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
// Datas (mesmas regras do app)
// ---------------------------------------------------------------------------

// Hoje + N dias UTEIS, pulando sabado e domingo — o revPrazoPadrao do app. O
// Suite empurra qualquer data para o proximo dia util, entao calcular assim faz
// a tela mostrar o mesmo que vai valer no chamado.
function prazoPadrao(dias = 7): string {
  const [a, m, d] = hojeSaoPaulo().split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  let restantes = dias;
  while (restantes > 0) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) restantes--;
  }
  return dt.toISOString().slice(0, 10);
}

const dataBr = (iso: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split("-").reverse().join("/") : iso;
const competenciaBr = (c: string) =>
  /^\d{4}-\d{2}$/.test(c) ? `${c.slice(5, 7)}/${c.slice(0, 4)}` : c;

// Competencias oferecidas: 12 meses para tras ate 2 para frente.
function opcoesCompetencia(atual: string): C.ItemLista[] {
  const [a, m] = competenciaAtual().split("-").map(Number);
  const meses: string[] = [];
  for (let i = -12; i <= 2; i++) {
    const dt = new Date(Date.UTC(a, m - 1 + i, 1));
    meses.push(dt.toISOString().slice(0, 7));
  }
  if (atual && !meses.includes(atual)) meses.push(atual);
  return meses
    .sort()
    .reverse()
    .map((c) => ({ texto: competenciaBr(c), valor: c, selecionado: c === atual }));
}

const PRIORIDADES: C.ItemLista[] = [
  { texto: "Padrão do Suite", valor: "" },
  { texto: "1 · Baixa", valor: "1" },
  { texto: "2 · Média", valor: "2" },
  { texto: "3 · Alta", valor: "3" },
  { texto: "4 · Urgente", valor: "4" },
];
const rotuloPrioridade = (p: string) =>
  PRIORIDADES.find((x) => x.valor === p)?.texto.replace(/^\d · /, "") || "Padrão";

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

// Mesma lista que o /admin usa para separar o gasto de teste (admin.controller).
function ramalDeTeste(): string {
  return (process.env.RAMAIS_TESTE || "258").split(",")[0].trim() || "258";
}

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
      conteudo: String(d.transcricao || "").slice(0, MAX_CONTEUDO),
      anexos: (Array.isArray(d.anexos) ? d.anexos : []).map((a: any) => ({
        id: String(a.id),
        nome: String(a.nome || ""),
        tamanhoTexto: String(a.tamanhoTexto || ""),
        bloqueado: !!a.bloqueado,
        motivo: String(a.motivo || ""),
      })),
      naoResolvidos: [
        ...(refs.usuariosVinculados?.naoResolvidos || []),
        ...(refs.setoresVinculados?.naoResolvidos || []),
      ].map(String),
    };

    const setorFinal = refs.setor?.id ? String(refs.setor.id) : "";
    const executor = refs.executor?.id ? opc(refs.executor) : undefined;
    const pessoasIa: Opcao[] = (refs.usuariosVinculados?.itens || []).map(opc);
    const { corpo: corpoDesc } = partesDescricao(r.preview, cliente);
    const finalizadoIa = refs.finalizaApontamento?.valor === true;
    const internoIa = refs.isInterno?.valor === true;
    r.form = {
      titulo: refs.titulo?.valor || ia.titulo || "",
      clienteId: cliente?.id || "",
      empresas: [],
      modoEmpresas: "independente",
      assuntoId: refs.tipo?.id ? String(refs.tipo.id) : "",
      origemId: refs.origem?.id ? String(refs.origem.id) : "",
      setorId: setorFinal,
      // O principal sempre primeiro; o que a IA sugeriu vem depois (app).
      setoresExtra: (refs.setoresVinculados?.itens || [])
        .map(opc)
        .filter((s: Opcao) => s.id !== setorFinal),
      executorId: executor?.id || "",
      // Quem vai atender tambem acompanha (revGarantirExecutorVinculado).
      pessoas:
        executor && !pessoasIa.some((p) => p.id === executor.id)
          ? [...pessoasIa, executor]
          : pessoasIa,
      pessoasDoSetor: [],
      processos: [],
      // Competencia SEMPRE no mes corrente (decisao de produto do app): e o
      // caso da maioria, e sobrepoe a sugestao da IA de proposito.
      competencia: competenciaAtual(),
      prioridade: refs.prioridade?.valor ? String(refs.prioridade.valor) : "",
      // O prazo que a IA achou no texto ("ate sexta") vale; senao 7 dias uteis.
      prazo: refs.prazo?.valor || prazoPadrao(7),
      visibilidade: refs.visibilidade?.valor === "restrito" ? "restrito" : "publico",
      interno: internoIa,
      enviarEmails: refs.enviarEmails?.valor === true,
      finalizado: finalizadoIa,
      corpo: corpoDesc,
      anexos: [], // como no app: nenhum anexo vai sem a pessoa marcar
      campos: {},
    };
    r.corpoSistema = corpoDesc;
    r.opcoes = {
      clientes: cliente ? [cliente] : [],
      assuntos: refs.tipo?.id ? [opc(refs.tipo)] : [],
      executores: executor ? [executor] : [],
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
      interno: internoIa,
      internoFonte: String(refs.isInterno?.fonte || "ausente"),
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

// Espera a tarefa ate `ms`; devolve se ela terminou a tempo.
async function terminouEm(tarefa: Promise<unknown>, ms: number): Promise<boolean> {
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

function emSegundoPlano(tarefa: Promise<unknown>): void {
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
// Cliente, assunto, executor, setor, origem e as listas (empresas, setores,
// pessoas, processos) NAO sao lidos aqui: na tela eles sao linhas com
// "Trocar"/"Remover" e so mudam pelas acoes proprias.
function absorverFormulario(r: Rascunho, evento: unknown): void {
  const f = r.form!;
  f.titulo = C.lerCampo(evento, "titulo");
  f.finalizado = C.lerInterruptor(evento, "finalizado");
  f.corpo = C.lerCampo(evento, "descricao");
  f.competencia = C.lerCampo(evento, "competencia") || f.competencia;
  f.prioridade = C.lerCampo(evento, "prioridade");
  f.prazo = C.lerData(evento, "prazo") || "";
  f.visibilidade = C.lerCampo(evento, "visibilidade") === "restrito" ? "restrito" : "publico";
  f.interno = C.lerInterruptor(evento, "interno");
  f.enviarEmails = C.lerInterruptor(evento, "enviar_emails");
  if (f.empresas.length) {
    f.modoEmpresas =
      C.lerCampo(evento, "modo_empresas") === "agrupado_sincronizado"
        ? "agrupado_sincronizado"
        : "independente";
  }
  if (r.preview?.anexos.some((a) => !a.bloqueado)) {
    f.anexos = C.lerLista(evento, "anexos");
  }
  for (const d of r.camposDef || []) {
    const nome = `cp_${d.id}`;
    if (d.tipo === "booleano") f.campos[d.id] = C.lerInterruptor(evento, nome);
    else if (d.tipo === "data") f.campos[d.id] = C.lerData(evento, nome) || "";
    else f.campos[d.id] = C.lerCampo(evento, nome);
  }
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
  visibilidade: "visibilidade",
  modo_criacao: "como criar para várias empresas",
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
  if (f.prazo && f.prazo < hojeSaoPaulo()) falta.push("prazo (a data já passou)");
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

// "interno" tem TRES estados no app: sim, nao e "ninguem decidiu". Sem decisao
// a chave nao vai, e vale o padrao do ASSUNTO no Suite — mandar false sempre
// derrubaria essa configuracao em silencio. Decidiu: o sistema (lookup/IA) ou
// a pessoa, ao mudar o valor.
function internoDecidido(r: Rascunho): boolean {
  const s = r.sugestao!;
  return ["lookup", "ia"].includes(s.internoFonte) || r.form!.interno !== s.interno;
}

const modoExecutor = (r: Rascunho) =>
  r.usuario && r.form!.executorId === r.usuario.id ? "eu" : "escolher";

function montarBodyCriar(r: Rascunho): Record<string, unknown> {
  const f = r.form!;
  const modo = modoExecutor(r);
  const campos: Record<string, unknown> = {};
  for (const d of r.camposDef || []) {
    const v = f.campos[d.id];
    if (v === undefined || v === null || v === "") continue;
    campos[d.id] = v;
  }
  const outras = f.empresas.map((e) => e.id).filter((id) => id && id !== f.clienteId);
  const unicos = (ids: string[]) => ids.filter((id, i) => id && ids.indexOf(id) === i);
  return {
    ...(r.threadId ? { threadId: r.threadId } : { messageId: r.messageId }),
    anexosEscolhidos: f.anexos,
    cliente_id: f.clienteId,
    // Varias empresas: o cliente principal continua indo separado (e a chave
    // de idempotencia e de custo no backend).
    cliente_ids: outras.length ? unicos([f.clienteId, ...outras]) : undefined,
    modo_criacao: outras.length ? f.modoEmpresas : undefined,
    tipo_apontamento_id: f.assuntoId,
    descricao: descricaoFinal(r),
    origem_id: f.origemId,
    setores_vinculados: unicos([f.setorId, ...f.setoresExtra.map((s) => s.id)]),
    executor_id: f.executorId,
    executor_modo: modo,
    responsavel_conclusao_id: modo === "escolher" ? f.executorId : undefined,
    titulo: f.titulo,
    competencia: f.competencia || undefined,
    prioridade: f.prioridade || undefined,
    prazo_personalizado_data: f.prazo || undefined,
    // Publico e o padrao do Suite: so vai quando for diferente (app).
    visibilidade: f.visibilidade !== "publico" ? f.visibilidade : undefined,
    ...(internoDecidido(r) ? { is_interno: f.interno } : {}),
    usuarios_vinculados: unicos(f.pessoas.map((p) => p.id)),
    processos_vinculados: f.processos.map((p) => p.id),
    campos_personalizados: Object.keys(campos).length ? campos : undefined,
    // Os dois vao sempre, como no app: o padrao da API ja e false.
    finaliza_apontamento: f.finalizado,
    enviar_emails: f.enviarEmails,
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

const corpoEditado = (r: Rascunho) =>
  (r.form?.corpo || "").trim() !== (r.corpoSistema || "").trim();

function feedbackImplicito(r: Rascunho): Record<string, unknown> {
  const s = r.sugestao!;
  const f = r.form!;
  const dif = (a?: string, b?: string) => String(a || "") !== String(b || "");
  const sistema = r.corpoSistema || "";
  const editado = corpoEditado(r);
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
      executorModo: modoExecutor(r),
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

// Logo azul da Contas (o app e azul). Mesmo endereco do icone em addon/*.json.
const LOGO = "https://contas.com.br/wp-content/uploads/2024/09/Contas-Contabilidade_logo.png";
// Azul principal do app (--primary do tema claro, renderer/style.css: #0a4a97).
const AZUL: C.Cor = { red: 0.04, green: 0.29, blue: 0.59 };

// Campos que abrem busca ou lista. Os "unicos" trocam um valor; os de lista
// acrescentam um item (o "+" e os chips do app).
const EDITORES = {
  cliente: { rotulo: "Cliente", busca: true, dica: "Nome ou CNPJ" },
  empresa: { rotulo: "Empresa", busca: true, dica: "Nome ou CNPJ" },
  assunto: { rotulo: "Assunto", busca: true },
  executor: { rotulo: "Executor", busca: true },
  pessoa: { rotulo: "Pessoa", busca: true },
  processo: { rotulo: "Processo", busca: true },
  setor: { rotulo: "Setor", busca: false },
  setor_extra: { rotulo: "Setor", busca: false },
  origem: { rotulo: "Origem", busca: false },
} as const;
type Editor = keyof typeof EDITORES;
const ehEditor = (s: string): s is Editor => s in EDITORES;

// Listas de itens com "Remover" (os chips do app).
const LISTAS = {
  empresas: "empresas",
  setores: "setoresExtra",
  pessoas: "pessoas",
  processos: "processos",
} as const;
type Lista = keyof typeof LISTAS;
const ehLista = (s: string): s is Lista => s in LISTAS;

function cartaoContas(p: Omit<Parameters<typeof C.cartao>[0], "imagem">) {
  return C.cartao({ ...p, imagem: LOGO });
}

function telaMensagem(titulo: string, texto: string, botao?: { texto: string; acao: C.Acao }) {
  return cartaoContas({
    titulo,
    secoes: [{ widgets: [C.paragrafo(C.esc(texto))] }],
    ...(botao ? { botaoPrincipal: { ...botao, cor: AZUL } } : {}),
  });
}

function telaConectar() {
  return cartaoContas({
    titulo: "Conecte sua conta",
    secoes: [
      {
        widgets: [
          C.item({ icone: "PERSON", texto: "<b>Falta conectar esta conta no app</b>" }),
          C.paragrafo(cinza(MSG_CONECTAR)),
        ],
      },
    ],
  });
}

function telaInicio() {
  return cartaoContas({
    titulo: "Abrir chamado",
    subtitulo: "Contas Contabilidade",
    secoes: [
      {
        titulo: "Como funciona",
        widgets: [
          C.item({
            icone: "EMAIL",
            texto: "<b>Abra um e-mail</b>",
            rodape: "A conversa que vai virar chamado",
          }),
          C.item({
            icone: "STAR",
            texto: "<b>Prepare com a IA</b>",
            rodape: "Cliente, assunto e resumo já preenchidos",
          }),
          C.item({
            icone: "CONFIRMATION_NUMBER_ICON",
            texto: "<b>Confira e crie</b>",
            rodape: "Nada vai ao Suite sem você confirmar",
          }),
        ],
      },
    ],
  });
}

// E-mail aberto: o caminho principal e abrir a revisao no app desktop. No
// painel, a IA esbarra no limite de poucos segundos do Google e a pessoa
// ficava clicando em "Atualizar".
function telaAbrirNoApp(threadId: string, messageId: string, ctx: Ctx) {
  return cartaoContas({
    titulo: "Abrir chamado",
    subtitulo: "Esta conversa ainda não tem chamado",
    secoes: [
      {
        widgets: [
          C.item({
            icone: "DESCRIPTION",
            texto: "<b>Revise no Assistente de Reuniões</b>",
            rodape: "O app abre o formulário deste e-mail",
          }),
          C.item({
            icone: "STAR",
            texto: "<b>A IA prepara no app</b>",
            rodape: "Cliente, assunto e resumo já preenchidos",
          }),
        ],
      },
    ],
    botaoPrincipal: {
      texto: "Abrir no app",
      acao: C.acao(ctx.url("abrir"), { threadId, messageId }),
      cor: AZUL,
    },
  });
}

interface EmailDaConversa extends MensagemDaThread {
  // Presente quando este e-mail sozinho ja virou chamado (o "Separar
  // mensagens" do app). Protocolo pode vir vazio em dry-run.
  chamado?: { protocolo: string };
}

const quandoCurto = (ms: number) =>
  ms
    ? new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(ms))
    : "";

// O snippet do Gmail vem com entidades HTML (&#39;); o cartao escapa de novo.
const textoDoSnippet = (s: string) =>
  s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// Conversa com mais de um e-mail: um chamado com a conversa inteira (botao
// principal, como sempre) ou com UM e-mail so — o "Separar mensagens" da aba
// E-mails do app, aqui no Gmail. O app 1.7.5 ja abre um e-mail sozinho
// (pedido so com messageId), entao isto nao precisou de versao nova do app.
function telaEscolherEmail(
  threadId: string,
  messageId: string,
  conversa: { emails: EmailDaConversa[]; total: number },
  ctx: Ctx,
) {
  const { emails, total } = conversa;
  const linhas: C.Widget[] = emails.map((m) =>
    C.item({
      icone: "EMAIL",
      rotulo: quandoCurto(m.quando),
      texto: `<b>${C.esc(m.fromNome || m.fromEmail || "(sem remetente)")}</b>`,
      rodape: m.chamado
        ? `Já virou chamado${m.chamado.protocolo ? ` ${m.chamado.protocolo}` : ""}`
        : curto(textoDoSnippet(m.snippet), 90),
      ...(m.chamado
        ? {}
        : { botao: { texto: "Abrir", acao: C.acao(ctx.url("abrir"), { messageId: m.id }) } }),
    }),
  );
  if (total > emails.length) {
    linhas.unshift(C.paragrafo(cinza(`Mostrando os ${emails.length} mais recentes de ${total}.`)));
  }
  return cartaoContas({
    titulo: "Abrir chamado",
    subtitulo: `Conversa com ${total} e-mails`,
    secoes: [
      {
        widgets: [
          C.paragrafo(
            cinza(
              "O botão de baixo abre a conversa inteira num chamado só. Para um e-mail só, use o Abrir dele.",
            ),
          ),
        ],
      },
      { titulo: "Ou só um e-mail", widgets: linhas },
    ],
    botaoPrincipal: {
      texto: "Abrir conversa inteira",
      acao: C.acao(ctx.url("abrir"), { threadId, messageId }),
      cor: AZUL,
    },
  });
}

function telaAbrindo(threadId: string, messageId: string, ctx: Ctx) {
  return cartaoContas({
    titulo: "Abrindo no app…",
    secoes: [
      {
        widgets: [
          C.item({
            icone: "CLOCK",
            texto: "<b>Olhe o Assistente de Reuniões</b>",
            rodape: "A revisão deste e-mail abre lá",
          }),
          C.paragrafo(
            cinza(
              `Não abriu? Confira se o app está aberto neste computador, com a conta ${ctx.conta} ativa.`,
            ),
          ),
          C.botoes([
            { texto: "Abrir de novo", acao: C.acao(ctx.url("abrir"), { threadId, messageId }) },
          ]),
        ],
      },
    ],
  });
}

// O app desta conta nunca se registrou (versao antiga, fechado desde sempre ou
// outra conta ativa). A revisao no proprio painel fica como saida, com o
// "Atualizar" de sempre.
function telaSemApp(threadId: string, messageId: string, ctx: Ctx) {
  return cartaoContas({
    titulo: "App não encontrado",
    secoes: [
      {
        widgets: [
          C.item({
            icone: "PERSON",
            texto: "<b>Não achei o app desta conta</b>",
            rodape: ctx.conta,
          }),
          C.paragrafo(
            cinza(
              "Abra o Assistente de Reuniões neste computador, na versão mais nova e " +
                "com esta conta ativa, e tente de novo.",
            ),
          ),
          C.botoes([
            { texto: "Tentar de novo", acao: C.acao(ctx.url("abrir"), { threadId, messageId }), cor: AZUL },
            { texto: "Revisar aqui no Gmail", acao: C.acao(ctx.url("preparar"), { threadId, messageId }) },
          ]),
        ],
      },
    ],
  });
}

function telaJaTem(protocolo: string) {
  return cartaoContas({
    titulo: "Chamado já criado",
    subtitulo: "Esta conversa já virou chamado",
    secoes: [
      {
        widgets: [
          C.item({
            icone: "CONFIRMATION_NUMBER_ICON",
            rotulo: "Protocolo",
            texto: protocolo ? `<b>${C.esc(protocolo)}</b>` : "Criado no Suite",
          }),
        ],
      },
    ],
  });
}

function telaGerando(r: Rascunho, ctx: Ctx) {
  return cartaoContas({
    titulo: "Preparando o chamado…",
    secoes: [
      {
        widgets: [
          C.item({
            icone: "CLOCK",
            texto: "<b>A IA está lendo a conversa</b>",
            rodape: "Conversas longas levam mais alguns segundos",
          }),
          C.paragrafo(cinza("Clique em Atualizar daqui a pouco.")),
        ],
      },
    ],
    botaoPrincipal: {
      texto: "Atualizar",
      acao: C.acao(ctx.url("atualizar"), { rascunho: r.id }),
      cor: AZUL,
    },
  });
}

const rotuloOpcao = (o: Opcao) =>
  curto(o.cnpj ? `${o.nome} — ${o.cnpj}` : o.extra ? `${o.nome} (${o.extra})` : o.nome, 90);

// Busca/lista do campo que a pessoa abriu. Item vazio na frente: sem ele o
// Google ja deixa o primeiro selecionado e o "ao mudar" nunca dispara para ele.
function editorAberto(
  r: Rascunho,
  ctx: Ctx,
  campo: Editor,
  listaFixa?: Opcao[],
): C.Widget[] {
  const cfg = EDITORES[campo];
  const escolher = C.acao(ctx.url("escolher"), { rascunho: r.id, campo });
  const cancelar = { texto: "Cancelar", acao: C.acao(ctx.url("editar"), { rascunho: r.id }) };
  const vazio: C.ItemLista = { texto: "— escolha —", valor: "", selecionado: true };
  const dropdown = (itens: Opcao[], rotulo: string) =>
    C.lista({
      nome: `escolha_${campo}`,
      rotulo,
      itens: [vazio, ...itens.map((o) => ({ texto: rotuloOpcao(o), valor: o.id }))],
      aoMudar: escolher,
    });

  if (!cfg.busca) {
    return [dropdown(listaFixa || [], `Escolha o ${cfg.rotulo.toLowerCase()}`), C.botoes([cancelar])];
  }

  const resultados = r.resultados || [];
  const total = r.resultadosTotal || resultados.length;
  const saida: C.Widget[] = [
    C.campoTexto({
      nome: `busca_${campo}`,
      rotulo: `Buscar ${cfg.rotulo.toLowerCase()}`,
      dica: "dica" in cfg ? cfg.dica : undefined,
    }),
    C.botoes([
      {
        texto: "Buscar",
        acao: C.acao(ctx.url("buscar"), { rascunho: r.id, alvo: campo }),
        cor: AZUL,
      },
      cancelar,
    ]),
  ];
  if (resultados.length) {
    saida.push(dropdown(resultados, "Escolha um"));
    if (total > resultados.length) {
      saida.push(
        C.paragrafo(cinza(`Mostrando ${resultados.length} de ${total}. Busque para achar outro.`)),
      );
    }
  }
  return saida;
}

interface InfoCampo {
  icone: C.Icone;
  rotulo: string;
  nome: string; // vazio = nada escolhido
  rodape?: string;
  lista?: Opcao[]; // setor/origem: lista completa, sem busca
}

// Um dado escolhido vira uma linha limpa com "Trocar". So o campo que a pessoa
// esta trocando abre busca e lista.
function linhaCampo(r: Rascunho, ctx: Ctx, campo: Editor, info: InfoCampo): C.Widget[] {
  const atual = info.nome ? `<b>${C.esc(info.nome)}</b>` : vermelho("Não escolhido");
  const linha = (comBotao: boolean) =>
    C.item({
      icone: info.icone,
      rotulo: info.rotulo,
      texto: atual,
      rodape: info.rodape,
      ...(comBotao
        ? {
            botao: {
              texto: info.nome ? "Trocar" : "Escolher",
              acao: C.acao(ctx.url("editar"), { rascunho: r.id, campo }),
            },
          }
        : {}),
    });
  if (r.editando !== campo) return [linha(true)];
  return [linha(false), ...editorAberto(r, ctx, campo, info.lista)];
}

// Lista de itens com "Remover" e um botao para acrescentar (os chips do app).
function blocoLista(
  r: Rascunho,
  ctx: Ctx,
  p: {
    lista: Lista;
    editor: Editor;
    icone: C.Icone;
    itens: Opcao[];
    rodape?: (o: Opcao) => string | undefined;
    adicionar: string;
    vazio: string;
    extras?: C.Botao[];
    listaFixa?: Opcao[];
  },
): C.Widget[] {
  const saida: C.Widget[] = p.itens.map((o) =>
    C.item({
      icone: p.icone,
      texto: C.esc(rotuloOpcao(o)),
      rodape: p.rodape?.(o),
      botao: {
        texto: "Remover",
        acao: C.acao(ctx.url("remover"), { rascunho: r.id, lista: p.lista, id: o.id }),
      },
    }),
  );
  if (!p.itens.length) saida.push(C.paragrafo(cinza(p.vazio)));
  if (r.editando === p.editor) {
    saida.push(...editorAberto(r, ctx, p.editor, p.listaFixa));
  } else {
    saida.push(
      C.botoes([
        {
          texto: p.adicionar,
          acao: C.acao(ctx.url("editar"), { rascunho: r.id, campo: p.editor }),
        },
        ...(p.extras || []),
      ]),
    );
  }
  return saida;
}

async function telaRevisao(r: Rascunho, ctx: Ctx, aviso?: string) {
  const p = r.preview!;
  const f = r.form!;
  const [setores, origens] = await Promise.all([
    listaSetores().catch(() => [] as Opcao[]),
    listaOrigens().catch(() => [] as Opcao[]),
  ]);
  const nomeEm = (lista: Opcao[] | undefined, id: string, reserva: string) =>
    id ? lista?.find((o) => o.id === id)?.nome || `${reserva} ${id}` : "";
  const cliente = clienteEscolhido(r);
  const sugerido = (id: string, idIa?: string) =>
    id && id === idIa ? "Sugerido pela IA" : undefined;

  // --- avisos -------------------------------------------------------------
  const avisos: C.Widget[] = [];
  if (aviso) avisos.push(C.paragrafo(vermelho(aviso)));
  if (!p.iaOk) {
    avisos.push(
      C.paragrafo(laranja("A IA não gerou o resumo. Confira e escreva a descrição.")),
    );
  }
  if (p.dryRun || ctx.simular) {
    avisos.push(C.paragrafo(laranja("Modo teste: nada vai para o Suite.")));
  }
  const falta = faltando(r);
  if (falta.length && !aviso) {
    avisos.push(C.paragrafo(cinza(`Ainda falta: ${falta.join(", ")}.`)));
  }

  // --- cliente, empresas, assunto, origem ----------------------------------
  const chamado: C.Widget[] = [
    C.campoTexto({ nome: "titulo", rotulo: "Título", valor: f.titulo }),
    ...linhaCampo(r, ctx, "cliente", {
      icone: "STORE",
      rotulo: "Cliente vinculado",
      nome: cliente?.nome || (f.clienteId ? `Cliente ${f.clienteId}` : ""),
      rodape: cliente?.cnpj || sugerido(f.clienteId, r.sugestao?.clienteId),
    }),
  ];
  // Varias empresas (o "+" ao lado do cliente no app).
  if (f.empresas.length || r.editando === "empresa") {
    chamado.push(
      ...blocoLista(r, ctx, {
        lista: "empresas",
        editor: "empresa",
        icone: "STORE",
        itens: f.empresas,
        rodape: (o) => o.cnpj,
        adicionar: "+ Outra empresa",
        vazio: "Nenhuma outra empresa.",
      }),
    );
    if (f.empresas.length) {
      chamado.push(
        C.lista({
          nome: "modo_empresas",
          rotulo: "Como criar para várias empresas",
          itens: [
            {
              texto: "Um chamado para cada empresa",
              valor: "independente",
              selecionado: f.modoEmpresas === "independente",
            },
            {
              texto: "Um chamado agrupado (andam juntos)",
              valor: "agrupado_sincronizado",
              selecionado: f.modoEmpresas === "agrupado_sincronizado",
            },
          ],
        }),
      );
    }
  } else {
    chamado.push(
      C.botoes([
        {
          texto: "+ Outra empresa",
          acao: C.acao(ctx.url("editar"), { rascunho: r.id, campo: "empresa" }),
        },
      ]),
    );
  }
  chamado.push(
    ...linhaCampo(r, ctx, "assunto", {
      icone: "BOOKMARK",
      rotulo: "Assunto (tipo do chamado)",
      nome: nomeEm(r.opcoes?.assuntos, f.assuntoId, "Assunto"),
      rodape: sugerido(f.assuntoId, r.sugestao?.assuntoId),
    }),
    ...linhaCampo(r, ctx, "origem", {
      icone: "EMAIL",
      rotulo: "Origem",
      nome: nomeEm(origens, f.origemId, "Origem"),
      lista: origens,
    }),
  );

  // --- campos do assunto ----------------------------------------------------
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
  if (r.camposFalharam) {
    campos.push(
      C.paragrafo(laranja("Não consegui carregar os campos deste assunto.")),
      C.botoes([
        { texto: "Tentar de novo", acao: C.acao(ctx.url("campos"), { rascunho: r.id }) },
      ]),
    );
  }

  // --- quem atende ----------------------------------------------------------
  const atende: C.Widget[] = [
    ...linhaCampo(r, ctx, "setor", {
      icone: "MULTIPLE_PEOPLE",
      rotulo: "Setor",
      nome: nomeEm(setores, f.setorId, "Setor"),
      lista: setores,
    }),
    ...linhaCampo(r, ctx, "executor", {
      icone: "PERSON",
      rotulo: "Executor (quem vai atender)",
      nome: nomeEm(r.opcoes?.executores, f.executorId, "Usuário"),
      rodape: r.usuario && f.executorId === r.usuario.id ? "Eu mesmo" : undefined,
    }),
    C.interruptor({
      nome: "finalizado",
      rotulo: "Criar já finalizado",
      ligado: f.finalizado,
      descricao:
        r.sugestao?.finalizado && r.sugestao.finalizadoMotivo
          ? curto(`Sugerido pela IA: ${r.sugestao.finalizadoMotivo}`, 140)
          : "Ligado, ninguém vai trabalhar nele depois",
    }),
  ];

  // --- quem acompanha -------------------------------------------------------
  const setorNome = nomeEm(setores, f.setorId, "Setor");
  const acompanha: C.Widget[] = [
    C.paragrafo("<b>Setores vinculados</b>"),
    ...blocoLista(r, ctx, {
      lista: "setores",
      editor: "setor_extra",
      icone: "MULTIPLE_PEOPLE",
      itens: f.setoresExtra,
      adicionar: "+ Adicionar setor",
      vazio: "Só o setor principal.",
      listaFixa: setores.filter(
        (s) => s.id !== f.setorId && !f.setoresExtra.some((x) => x.id === s.id),
      ),
    }),
    C.paragrafo("<b>Usuários vinculados</b>"),
    ...blocoLista(r, ctx, {
      lista: "pessoas",
      editor: "pessoa",
      icone: "PERSON",
      itens: f.pessoas,
      rodape: (o) =>
        o.id === f.executorId
          ? "Executor"
          : f.pessoasDoSetor.includes(o.id)
            ? "Do setor"
            : undefined,
      adicionar: "+ Adicionar pessoa",
      vazio: "Ninguém acompanha.",
      extras: f.setorId
        ? [
            {
              texto: f.pessoasDoSetor.length ? "Tirar o setor" : "Todo o setor",
              acao: C.acao(ctx.url("setor-pessoas"), { rascunho: r.id }),
            },
          ]
        : [],
    }),
  ];
  if (p.naoResolvidos.length) {
    acompanha.push(
      C.paragrafo(
        laranja(
          `A IA citou, mas não encontrei no Suite: ${p.naoResolvidos.join(", ")}. ` +
            "Adicione à mão se fizer sentido.",
        ),
      ),
    );
  }

  // --- mais opcoes (sem recolher: tem campos de formulario) ----------------
  const mais: C.Widget[] = [
    C.lista({
      nome: "competencia",
      rotulo: "Competência",
      itens: opcoesCompetencia(f.competencia),
    }),
    C.lista({
      nome: "prioridade",
      rotulo: "Prioridade",
      itens: PRIORIDADES.map((x) => ({ ...x, selecionado: x.valor === f.prioridade })),
    }),
    C.campoData({ nome: "prazo", rotulo: "Prazo personalizado", valorIso: f.prazo }),
    C.lista({
      nome: "visibilidade",
      rotulo: "Visibilidade",
      itens: [
        { texto: "Público", valor: "publico", selecionado: f.visibilidade === "publico" },
        { texto: "Restrito", valor: "restrito", selecionado: f.visibilidade === "restrito" },
      ],
    }),
    C.interruptor({
      nome: "interno",
      rotulo: "Chamado interno",
      ligado: f.interno,
      descricao: "Não envolve cliente externo",
    }),
    C.interruptor({
      nome: "enviar_emails",
      rotulo: "Enviar e-mails de notificação ao criar",
      ligado: f.enviarEmails,
    }),
    C.paragrafo("<b>Processos vinculados</b>"),
    ...blocoLista(r, ctx, {
      lista: "processos",
      editor: "processo",
      icone: "DESCRIPTION",
      itens: f.processos,
      adicionar: "+ Adicionar processo",
      vazio: setorNome
        ? `Nenhum processo (opcional; só do setor ${setorNome}).`
        : "Nenhum processo (opcional).",
    }),
  ];

  // --- resumo -------------------------------------------------------------
  const resumo: C.Widget[] = [
    C.campoTexto({
      nome: "descricao",
      rotulo: "Resumo do chamado (editável)",
      valor: f.corpo,
      multilinha: true,
    }),
    C.botoes([
      { texto: "↻ Regenerar resumo (IA)", acao: C.acao(ctx.url("regenerar"), { rascunho: r.id }) },
    ]),
    ...widgetsFeedback(r, ctx, r.feedbackRevisao, "revisao"),
  ];

  // --- anexos ---------------------------------------------------------------
  const anexos: C.Widget[] = [];
  const liberados = p.anexos.filter((a) => !a.bloqueado);
  if (liberados.length) {
    anexos.push(
      C.lista({
        nome: "anexos",
        rotulo: `Anexar ao chamado (${f.anexos.length} de ${liberados.length})`,
        tipo: "CHECK_BOX",
        itens: liberados.map((a) => ({
          texto: curto(`${a.nome} (${a.tamanhoTexto})`, 90),
          valor: a.id,
          selecionado: f.anexos.includes(a.id),
        })),
      }),
      C.botoes([
        { texto: "Selecionar tudo", acao: C.acao(ctx.url("anexos"), { rascunho: r.id, modo: "todos" }) },
        { texto: "Limpar seleção", acao: C.acao(ctx.url("anexos"), { rascunho: r.id, modo: "nenhum" }) },
      ]),
    );
  }
  for (const a of p.anexos.filter((x) => x.bloqueado)) {
    anexos.push(C.paragrafo(cinza(`${a.nome}: não pode ir (${a.motivo}).`)));
  }

  // --- so leitura (recolhidas) ---------------------------------------------
  const { cabecalho } = partesDescricao(p, cliente);
  const dadosEmail: C.Widget[] = [
    C.item({ icone: "EMAIL", rotulo: "Remetente", texto: C.esc(p.chamada.remetente || p.email.de || "-") }),
    C.item({ icone: "BOOKMARK", rotulo: "Assunto", texto: C.esc(p.chamada.assunto || p.email.assunto || "-") }),
    C.item({ icone: "PERSON", rotulo: "Responsável", texto: C.esc(p.chamada.atendente || "-") }),
    C.item({ icone: "CLOCK", rotulo: "Recebido", texto: C.esc(p.email.data || "-") }),
  ];
  const textoLongo = (t: string, n: number) =>
    C.paragrafo(C.esc(curto(t || "-", n)).replace(/\n/g, "<br>"));

  return cartaoContas({
    titulo: "Revisar chamado",
    subtitulo: curto(p.email.assunto || "(sem assunto)"),
    secoes: [
      { widgets: avisos },
      { widgets: chamado },
      { titulo: "Campos do assunto", widgets: campos },
      { titulo: "Quem atende", widgets: atende },
      { titulo: "Quem acompanha", widgets: acompanha },
      { titulo: "Mais opções do chamado", widgets: mais },
      // Recolhidas mostrando 1 item: e o caso de uso comum do Google, e estas
      // secoes so tem leitura (campo de formulario nunca vai em secao recolhida).
      { titulo: "Dados do e-mail", recolhida: 1, widgets: dadosEmail },
      {
        titulo: "Conteúdo do e-mail",
        recolhida: 1,
        widgets: [C.paragrafo(cinza("O texto que a IA leu.")), textoLongo(p.conteudo, 4000)],
      },
      {
        titulo: "Dados do atendimento",
        recolhida: 1,
        widgets: [
          C.paragrafo(cinza("Gerado pelo sistema; entra no começo da descrição.")),
          textoLongo(cabecalho, 2000),
        ],
      },
      { titulo: "Resumo", widgets: resumo },
      { titulo: "Anexos do e-mail", widgets: anexos },
    ],
    // Texto fixo de proposito: a tela nao se redesenha quando o interruptor
    // "finalizado" muda, e um "Criar chamado finalizado" velho enganaria.
    botaoPrincipal: {
      texto: ctx.simular ? "Simular criação" : "Criar chamado",
      acao: C.acao(ctx.url("criar"), { rascunho: r.id }),
      cor: AZUL,
    },
  });
}

// "A IA ajudou?" — o mesmo bloco serve a revisao (o "O resumo ficou bom?" do
// app) e a tela de chamado criado (o modal pos-chamado do app).
function widgetsFeedback(
  r: Rascunho,
  ctx: Ctx,
  estado: "up" | "down" | "abrindo" | undefined,
  onde: "revisao" | "criado",
): C.Widget[] {
  const nota = (n: string) => C.acao(ctx.url("feedback"), { rascunho: r.id, nota: n, onde });
  if (estado === "up" || estado === "down") {
    return [C.item({ icone: "STAR", texto: "<b>Obrigado pelo feedback!</b>" })];
  }
  if (estado === "abrindo") {
    return [
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
      C.campoTexto({ nome: "comentario", rotulo: "O que faltou ou errou? (opcional)", multilinha: true }),
      C.botoes([{ texto: "Enviar feedback", acao: nota("enviar"), cor: AZUL }]),
    ];
  }
  return [
    C.paragrafo(
      onde === "revisao"
        ? cinza("O resumo ficou bom?")
        : "O que a IA sugeriu (resumo, cliente, assunto) ajudou?",
    ),
    C.botoes([
      { texto: "👍 Ajudou", acao: nota("up") },
      { texto: "👎 Precisa melhorar", acao: nota("down") },
    ]),
  ];
}

function telaCriado(r: Rascunho, ctx: Ctx) {
  const c = r.criado!;
  const f = r.form!;
  const titulo = c.dryRun
    ? "Chamado simulado"
    : c.jaExistia
      ? "Chamado já existia"
      : "Chamado criado";
  const cliente = clienteEscolhido(r);
  const assunto = r.opcoes?.assuntos.find((a) => a.id === f.assuntoId)?.nome;
  const widgets: C.Widget[] = [
    C.item({
      icone: "CONFIRMATION_NUMBER_ICON",
      rotulo: c.protocolo.includes(",") ? "Protocolos" : "Protocolo",
      texto: c.protocolo
        ? `<b>${C.esc(c.protocolo)}</b>`
        : c.dryRun
          ? "Nada foi enviado ao Suite"
          : "Criado no Suite",
    }),
    ...(cliente?.nome ? [C.item({ icone: "STORE", rotulo: "Cliente", texto: C.esc(cliente.nome) })] : []),
    ...(assunto ? [C.item({ icone: "BOOKMARK", rotulo: "Assunto", texto: C.esc(assunto) })] : []),
    ...c.avisos.map((a) => C.paragrafo(laranja(a))),
  ];

  const secoes: C.Secao[] = [{ widgets }];
  // Feedback so em criacao real e nova, como no app. Nunca obrigatorio.
  if (!c.dryRun && !c.jaExistia) {
    secoes.push({ titulo: "A IA ajudou?", widgets: widgetsFeedback(r, ctx, c.feedback, "criado") });
  }
  return cartaoContas({
    titulo,
    subtitulo: curto(r.preview?.email.assunto || ""),
    secoes,
  });
}

// O `?simular=1` da URL de teste: mostra o que IRIA para o Suite, sem criar.
// Existe para o primeiro teste rodar contra o servidor de producao (que cria
// chamado de verdade) sem gerar chamado nenhum.
async function telaSimulada(r: Rascunho, ctx: Ctx) {
  const { chamado, avisos } = montarChamadoBodyDaRequisicao(montarBodyCriar(r));
  const { faltando: falta, invalidos } = validarChamadoBody(chamado);
  const [setores, origens] = await Promise.all([
    listaSetores().catch(() => [] as Opcao[]),
    listaOrigens().catch(() => [] as Opcao[]),
  ]);
  const f = r.form!;
  const nomeDe = (lista: Opcao[] | undefined, id: unknown) => {
    const s = String(id ?? "");
    return s ? lista?.find((o) => o.id === s)?.nome || s : "-";
  };
  const nomesDe = (lista: Opcao[] | undefined, ids: unknown) =>
    (Array.isArray(ids) ? ids : []).map((id) => nomeDe(lista, id)).join(", ") || "-";
  const linha = (icone: C.Icone, rotulo: string, valor: string) =>
    C.item({ icone, rotulo, texto: C.esc(valor) });
  const todasEmpresas = [...(r.opcoes?.clientes || []), ...f.empresas];

  const dados: C.Widget[] = [
    linha("STORE", "Cliente", nomeDe(r.opcoes?.clientes, chamado.cliente_id)),
    ...(chamado.cliente_ids?.length
      ? [
          linha("STORE", "Empresas", nomesDe(todasEmpresas, chamado.cliente_ids)),
          linha(
            "STORE",
            "Como",
            chamado.modo_criacao === "agrupado_sincronizado"
              ? "Um chamado agrupado"
              : "Um chamado para cada empresa",
          ),
        ]
      : []),
    linha("BOOKMARK", "Assunto", nomeDe(r.opcoes?.assuntos, chamado.tipo_apontamento_id)),
    linha("EMAIL", "Origem", nomeDe(origens, chamado.origem_id)),
    linha(
      "MULTIPLE_PEOPLE",
      "Setores",
      nomesDe([...setores, ...f.setoresExtra], chamado.setores_vinculados),
    ),
    linha("PERSON", "Executor", nomeDe(r.opcoes?.executores, chamado.executor_id)),
    linha("PERSON", "Usuários vinculados", nomesDe(f.pessoas, chamado.usuarios_vinculados)),
    linha(
      "CLOCK",
      "Competência · Prazo",
      `${competenciaBr(String(chamado.competencia || "-"))} · ${dataBr(String(chamado.prazo_personalizado_data || "-"))}`,
    ),
    linha(
      "STAR",
      "Prioridade · Visibilidade",
      `${rotuloPrioridade(String(chamado.prioridade ?? ""))} · ${chamado.visibilidade === "restrito" ? "Restrito" : "Público"}`,
    ),
    linha(
      "CONFIRMATION_NUMBER_ICON",
      "Interno · E-mails · Finalizado",
      [
        chamado.is_interno === undefined ? "padrão do assunto" : chamado.is_interno ? "sim" : "não",
        chamado.enviar_emails ? "sim" : "não",
        chamado.finaliza_apontamento ? "sim" : "não",
      ].join(" · "),
    ),
    linha("DESCRIPTION", "Processos", nomesDe(f.processos, chamado.processos_vinculados)),
    linha("DESCRIPTION", "Anexos", String(f.anexos.length || 0)),
  ];
  const problemas = [...falta, ...invalidos].map((x) => rotuloCampo(x, r.camposDef));
  if (problemas.length) {
    dados.push(C.paragrafo(vermelho(`O Suite recusaria: ${problemas.join(", ")}.`)));
  }
  for (const a of avisos) dados.push(C.paragrafo(laranja(a)));

  return cartaoContas({
    titulo: "Simulação",
    subtitulo: "Nada foi enviado ao Suite",
    secoes: [
      { widgets: dados },
      {
        titulo: "Descrição que iria",
        widgets: [
          C.paragrafo(
            C.esc(curto(String(chamado.descricao || ""), 1500)).replace(/\n/g, "<br>"),
          ),
        ],
      },
    ],
    botaoPrincipal: {
      texto: "Voltar à revisão",
      acao: C.acao(ctx.url("atualizar"), { rascunho: r.id }),
      cor: AZUL,
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
    return C.resposta.empurrar(telaConectar());
  }
  return C.resposta.empurrar(telaInicio());
}

// E-mail aberto: so mostra se ja tem chamado ou o "Abrir no app". Nada de IA
// (abrir e-mail nao pode custar dinheiro) e nada pesado: este cartao aparece a
// cada e-mail aberto, e o Google corta em poucos segundos.
async function acaoEmail(ctx: Ctx) {
  const { threadId, messageId } = idsDoEvento(ctx.evento);
  if (!threadId && !messageId) return C.resposta.empurrar(telaInicio());
  if (!(await contaConectada(ctx.conta))) {
    return C.resposta.empurrar(telaConectar());
  }

  // Thread = 1 chamado (regra do app). O messageId cobre quem usou "Separar
  // mensagens" no desktop.
  const item = threadId || messageId;
  const ja =
    (await getChamadoCriado(item, "gmail").catch(() => null)) ||
    (threadId && messageId
      ? await getChamadoCriado(messageId, "gmail").catch(() => null)
      : null);
  if (ja) return C.resposta.empurrar(telaJaTem(ja.protocolo || ""));

  // Conversa com mais de um e-mail: a pessoa escolhe qual vira chamado, ou a
  // conversa inteira (o "Separar mensagens" da aba E-mails do app).
  if (threadId) {
    const conversa = await emailsDaConversa(ctx.conta, threadId);
    if (conversa.total > 1) {
      return C.resposta.empurrar(telaEscolherEmail(threadId, messageId, conversa, ctx));
    }
  }

  // SEMPRE o "Abrir no app", mesmo que exista revisao feita aqui no painel. Ir
  // direto para ela (como era) montava o formulario inteiro e consultava o
  // Suite a cada e-mail aberto: no teste de 28/10/2026 isso ora mostrava o
  // formulario em vez do botao, ora dava 504. Quem usa a saida "Revisar aqui no
  // Gmail" continua de onde parou ao clicar nela (o preparar reaproveita).
  return C.resposta.empurrar(telaAbrirNoApp(threadId, messageId, ctx));
}

// Os e-mails da conversa, marcando os que ja viraram chamado sozinhos. Falhou
// ou demorou: devolve lista vazia, e o painel cai no "Abrir no app" da conversa
// inteira — o que ja funcionava. Nunca pode derrubar o cartao do e-mail.
async function emailsDaConversa(
  conta: string,
  threadId: string,
): Promise<{ emails: EmailDaConversa[]; total: number }> {
  const vazio = { emails: [], total: 0 };
  const chave = `addon:gmail:conversa:${conta}:${threadId}`;
  try {
    let lista = await cacheGet<MensagemDaThread[]>(chave).catch(() => null);
    if (!Array.isArray(lista)) {
      const busca = listarMensagensDaThread(conta, threadId);
      let timer: NodeJS.Timeout | undefined;
      const limite = new Promise<null>((ok) => {
        timer = setTimeout(() => ok(null), ESPERA_LISTA_CONVERSA_MS);
      });
      lista = await Promise.race([busca, limite]);
      if (timer) clearTimeout(timer);
      if (!lista) {
        busca.catch(() => undefined);
        console.warn(
          `[addon:gmail:email] lista da conversa passou de ${ESPERA_LISTA_CONVERSA_MS}ms; mostrando so a conversa inteira`,
        );
        return vazio;
      }
      await cacheSet(chave, lista, TTL_LISTA_CONVERSA_SEG).catch(() => undefined);
    }
    const recentes = lista.slice(-MAX_EMAILS_ESCOLHA);
    const criados = await Promise.all(
      recentes.map((m) => getChamadoCriado(m.id, "gmail").catch(() => null)),
    );
    return {
      emails: recentes.map((m, i) => ({
        ...m,
        ...(criados[i] ? { chamado: { protocolo: criados[i]!.protocolo || "" } } : {}),
      })),
      total: lista.length,
    };
  } catch (error) {
    console.warn(
      `[addon:gmail:email] lista da conversa falhou: ${getErrorMessage(error)}; mostrando so a conversa inteira`,
    );
    return vazio;
  }
}

// "Abrir no app": pede ao app desktop desta conta, pelo canal em tempo real do
// ramal dele (o mesmo do popup de chamada), que abra a revisao do e-mail. Com
// so o messageId (escolhido na lista da conversa), o app abre aquele e-mail
// sozinho; com o threadId, a conversa inteira.
async function acaoAbrir(ctx: Ctx) {
  const threadId = C.lerParametro(ctx.evento, "threadId");
  const messageId = C.lerParametro(ctx.evento, "messageId");
  if (!threadId && !messageId) {
    throw new AppError({
      statusCode: 400,
      code: "MESSAGE_ID_REQUIRED",
      message: "Abra um e-mail para abrir o chamado.",
    });
  }
  const ramal = await cacheGet<string>(chaveRamalDaConta(ctx.conta)).catch(() => null);
  if (!ramal) {
    console.warn(`[addon:gmail:abrir] conta=${ctx.conta} sem app registrado`);
    return C.resposta.atualizar(telaSemApp(threadId, messageId, ctx));
  }
  await publishAbrirEmail(String(ramal), {
    conta: ctx.conta,
    ...(threadId ? { threadId } : {}),
    ...(messageId ? { messageId } : {}),
  });
  console.log(
    `[addon:gmail:abrir] conta=${ctx.conta} ramal=${ramal} item=${threadId || messageId}`,
  );
  return C.resposta.atualizar(telaAbrindo(threadId, messageId, ctx));
}

// POST /api/gmail/vinculo — o app desktop avisa em qual ramal esta a conta
// Google dele, para o "Abrir no app" do painel saber para onde mandar.
// O profileToken prova que a conta foi conectada NESTE app (OAuth); o ramal e
// o mesmo que o app ja usa para receber os avisos de chamada. Fica no
// apiRouter (x-app-token), porque quem chama e o app, nao o Google.
export async function addonVinculoController(req: Request, res: Response) {
  const body = ensureBodyObject(req.body);
  const profileToken = getOptionalString(body, "profileToken") || "";
  const ramal = getOptionalString(body, "ramal") || "";
  if (!profileToken || !/^[\w.-]{1,20}$/.test(ramal)) {
    throw new AppError({
      statusCode: 400,
      code: "ADDON_VINCULO_INVALIDO",
      message: "Informe a conta conectada (profileToken) e o ramal.",
    });
  }
  const conta = await resolverContaGoogle(profileToken, "");
  await cacheSet(chaveRamalDaConta(conta), ramal, TTL_RAMAL_SEG);
  console.log(`[addon:vinculo] conta=${conta} ramal=${ramal}`);
  res.status(200).json({ ok: true, data: { conta, ramal } });
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
  const existente = await rascunhoValido(idExistente, ctx.conta);
  const abandonado =
    existente?.status === "gerando" &&
    Date.now() - existente.iniciadoEm > PREVIEW_ABANDONADO_MS;
  if (existente && existente.status !== "erro" && !existente.criado && !abandonado) {
    return C.resposta.atualizar(await telaDoRascunho(existente, ctx));
  }

  const r: Rascunho = {
    versao: VERSAO_RASCUNHO,
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
  const id = C.lerParametro(ctx.evento, "rascunho");
  let r = await lerRascunho(id, ctx.conta);
  // Ainda gerando: espera um pouco aqui mesmo (sempre dentro do tempo do
  // Google), em vez de devolver o "Atualizar" de novo na hora.
  const limite = Date.now() + ESPERA_ATUALIZAR_MS;
  while (r.status === "gerando" && Date.now() < limite) {
    await new Promise((ok) => setTimeout(ok, 1000));
    r = (await rascunhoValido(id, ctx.conta)) || r;
  }
  return C.resposta.atualizar(await telaDoRascunho(r, ctx));
}

// Rascunho da revisao, com o formulario da tela ja absorvido. Fora da revisao
// (gerando, criado) devolve `{ tela }`: quem chamou so redesenha a tela certa.
async function rascunhoEmRevisao(ctx: Ctx): Promise<Rascunho | { tela: unknown }> {
  const r = await lerRascunho(C.lerParametro(ctx.evento, "rascunho"), ctx.conta);
  if (r.status !== "pronto" || r.criado) {
    return { tela: C.resposta.atualizar(await telaDoRascunho(r, ctx)) };
  }
  absorverFormulario(r, ctx.evento);
  return r;
}

async function salvarERevisar(r: Rascunho, ctx: Ctx, aviso?: string) {
  await salvarRascunho(r);
  return C.resposta.atualizar(await telaRevisao(r, ctx, aviso));
}

// O que aparece de cara quando o campo abre, antes de qualquer busca: as
// pessoas do setor (executor/pessoa, como o dropdown do app), os processos do
// setor e os assuntos (o app abre a lista inteira ao focar).
async function listaInicial(r: Rascunho, campo: Editor): Promise<Opcao[]> {
  const f = r.form!;
  if (campo === "executor" || campo === "pessoa") {
    const doSetor = await pessoasDoSetor(f.setorId);
    const eu =
      campo === "executor" && r.usuario
        ? [{ id: r.usuario.id, nome: `Eu mesmo (${r.usuario.nome})` }]
        : [];
    return [...eu, ...doSetor.filter((p) => p.id !== r.usuario?.id || campo === "pessoa")];
  }
  if (campo === "processo") return (await buscarProcessos(f.setorId)).filter((p) => p.id).map(paraOpcao);
  if (campo === "assunto") return (await buscarTipos()).filter((t) => t.id).map(paraOpcao);
  return [];
}

// "Trocar"/"+ Adicionar" abre o campo; campo vazio fecha (o "Cancelar").
async function acaoEditar(ctx: Ctx) {
  const r = await rascunhoEmRevisao(ctx);
  if ("tela" in r) return r.tela;
  const campo = C.lerParametro(ctx.evento, "campo");
  r.editando = ehEditor(campo) ? campo : undefined;
  r.resultados = [];
  r.resultadosTotal = 0;
  let aviso: string | undefined;
  if (r.editando) {
    try {
      const lista = await listaInicial(r, r.editando as Editor);
      r.resultados = lista.slice(0, MAX_OPCOES);
      r.resultadosTotal = lista.length;
    } catch (error) {
      console.warn(
        `[addon:gmail:editar] rasc=${r.id} lista de ${campo} falhou: ${getErrorMessage(error)}`,
      );
      aviso = "Não consegui carregar a lista do Suite. Use a busca.";
    }
  }
  return salvarERevisar(r, ctx, aviso);
}

async function acaoBuscar(ctx: Ctx) {
  const r = await rascunhoEmRevisao(ctx);
  if ("tela" in r) return r.tela;
  const alvo = C.lerParametro(ctx.evento, "alvo");
  if (!ehEditor(alvo) || !EDITORES[alvo].busca) {
    throw new AppError({ statusCode: 400, code: "ADDON_ALVO_INVALIDO", message: MSG_INESPERADO });
  }
  r.editando = alvo;
  const termo = C.lerCampo(ctx.evento, `busca_${alvo}`);
  if (!termo) return salvarERevisar(r, ctx, "Digite o que buscar antes de clicar em Buscar.");

  let achados: Opcao[] = [];
  try {
    if (alvo === "cliente" || alvo === "empresa") {
      const digitos = termo.replace(/\D+/g, "");
      // Mesma regra do app: 11+ digitos e CPF/CNPJ, o resto e nome.
      const lista = await buscarClientes(
        digitos.length >= 11 ? { cnpj: digitos } : { q: termo },
      );
      achados = lista
        .filter((c) => c.id)
        .map((c) => ({ id: String(c.id), nome: c.razao_social || String(c.id), cnpj: c.cnpj }));
    } else if (alvo === "assunto") {
      achados = (await buscarTipos(termo)).filter((t) => t.id).map(paraOpcao);
    } else if (alvo === "processo") {
      achados = (await buscarProcessos(r.form!.setorId, termo)).filter((p) => p.id).map(paraOpcao);
    } else {
      achados = (await buscarUsuarios(termo)).itens.filter((u) => u.id).map(paraOpcao);
    }
  } catch (error) {
    // A busca falhar nao pode jogar fora o que a pessoa ja preencheu: o aviso
    // aparece na propria revisao.
    console.warn(
      `[addon:gmail:buscar] rasc=${r.id} busca de ${alvo} falhou: ${getErrorMessage(error)}`,
    );
    return salvarERevisar(r, ctx, `Não consegui buscar no Suite agora: ${mensagemParaPessoa(error)}`);
  }

  r.resultados = achados.slice(0, MAX_OPCOES);
  r.resultadosTotal = achados.length;
  return salvarERevisar(
    r,
    ctx,
    achados.length ? undefined : `Nada encontrado para "${curto(termo, 40)}".`,
  );
}

// Quem vai atender tambem acompanha (revGarantirExecutorVinculado do app).
function garantirExecutorVinculado(r: Rascunho): void {
  const f = r.form!;
  if (!f.executorId || f.pessoas.some((p) => p.id === f.executorId)) return;
  const nome = r.opcoes!.executores.find((o) => o.id === f.executorId)?.nome || "";
  f.pessoas.push({ id: f.executorId, nome });
  f.pessoasDoSetor = f.pessoasDoSetor.filter((id) => id !== f.executorId);
}

// A pessoa escolheu na lista do campo aberto. Fecha o campo e aplica as regras
// que o app aplica na mesma troca.
async function acaoEscolher(ctx: Ctx) {
  const r = await rascunhoEmRevisao(ctx);
  if ("tela" in r) return r.tela;
  const campo = C.lerParametro(ctx.evento, "campo");
  const valor = C.lerCampo(ctx.evento, `escolha_${campo}`);
  const f = r.form!;
  const escolhido = (r.resultados || []).find((o) => o.id === valor);
  const guardarEm = (lista: Opcao[], o: Opcao | undefined) => {
    if (o && !lista.some((x) => x.id === o.id)) lista.push(o);
  };
  let aviso: string | undefined;

  // "— escolha —" nao apaga o que ja estava escolhido.
  if (valor && ehEditor(campo)) {
    if (campo === "cliente") {
      guardarEm(r.opcoes!.clientes, escolhido);
      f.clienteId = valor;
      f.empresas = f.empresas.filter((e) => e.id !== valor);
    } else if (campo === "empresa") {
      if (valor !== f.clienteId) guardarEm(f.empresas, escolhido);
    } else if (campo === "assunto" && f.assuntoId !== valor) {
      guardarEm(r.opcoes!.assuntos, escolhido);
      f.assuntoId = valor;
      aviso = await carregarCampos(r, valor);
    } else if (campo === "executor") {
      // "Eu mesmo (Fulano)" vira so "Fulano" no nome guardado.
      const nome =
        r.usuario && valor === r.usuario.id ? r.usuario.nome : escolhido?.nome || "";
      guardarEm(r.opcoes!.executores, { id: valor, nome });
      f.executorId = valor;
      garantirExecutorVinculado(r);
    } else if (campo === "pessoa") {
      guardarEm(f.pessoas, escolhido);
    } else if (campo === "setor" && f.setorId !== valor) {
      f.setorId = valor;
      f.setoresExtra = f.setoresExtra.filter((s) => s.id !== valor);
      // Troca de setor: sai o pessoal do setor ANTIGO (o executor fica), e os
      // processos, que o Suite so aceita do setor do executor (regras do app).
      const sairam = new Set(f.pessoasDoSetor);
      f.pessoas = f.pessoas.filter((p) => !sairam.has(p.id) || p.id === f.executorId);
      f.pessoasDoSetor = [];
      if (f.processos.length) {
        f.processos = [];
        aviso = "Os processos vinculados saíram: eles dependem do setor.";
      }
    } else if (campo === "setor_extra") {
      const setores = await listaSetores().catch(() => [] as Opcao[]);
      if (valor !== f.setorId) guardarEm(f.setoresExtra, setores.find((s) => s.id === valor));
    } else if (campo === "origem") {
      f.origemId = valor;
    } else if (campo === "processo") {
      guardarEm(f.processos, escolhido);
    }
  }
  r.editando = undefined;
  r.resultados = [];
  r.resultadosTotal = 0;
  return salvarERevisar(r, ctx, aviso);
}

// Campos personalizados do assunto. Falhou: avisa e oferece "Tentar de novo",
// em vez de deixar o Suite recusar sem a pessoa entender (rev-campos-retry).
async function carregarCampos(r: Rascunho, assuntoId: string): Promise<string | undefined> {
  try {
    r.camposDef = assuntoId ? await buscarCamposDoTipo(assuntoId) : [];
    r.camposFalharam = false;
    return undefined;
  } catch (error) {
    console.warn(
      `[addon:gmail:campos] rasc=${r.id} campos do assunto falharam: ${getErrorMessage(error)}`,
    );
    r.camposDef = [];
    r.camposFalharam = true;
    return "Não consegui carregar os campos deste assunto. O Suite pode recusar se faltar algum.";
  }
}

async function acaoCampos(ctx: Ctx) {
  const r = await rascunhoEmRevisao(ctx);
  if ("tela" in r) return r.tela;
  const aviso = await carregarCampos(r, r.form!.assuntoId);
  return salvarERevisar(r, ctx, aviso);
}

// O "×" dos chips do app.
async function acaoRemover(ctx: Ctx) {
  const r = await rascunhoEmRevisao(ctx);
  if ("tela" in r) return r.tela;
  const lista = C.lerParametro(ctx.evento, "lista");
  const id = C.lerParametro(ctx.evento, "id");
  if (ehLista(lista)) {
    const f = r.form!;
    const chave = LISTAS[lista];
    f[chave] = f[chave].filter((o: Opcao) => o.id !== id);
    if (lista === "pessoas") f.pessoasDoSetor = f.pessoasDoSetor.filter((x) => x !== id);
  }
  return salvarERevisar(r, ctx);
}

// "Todo o setor" / "Tirar o setor": o botao nao guarda estado proprio; ligado
// e ter alguem que entrou por ele (mesma regra do app).
async function acaoSetorPessoas(ctx: Ctx) {
  const r = await rascunhoEmRevisao(ctx);
  if ("tela" in r) return r.tela;
  const f = r.form!;
  if (f.pessoasDoSetor.length) {
    const sairam = new Set(f.pessoasDoSetor);
    f.pessoas = f.pessoas.filter((p) => !sairam.has(p.id) || p.id === f.executorId);
    f.pessoasDoSetor = [];
    return salvarERevisar(r, ctx);
  }
  let pessoas: Opcao[];
  try {
    pessoas = await pessoasDoSetor(f.setorId);
  } catch (error) {
    console.warn(`[addon:gmail:setor-pessoas] rasc=${r.id} falhou: ${getErrorMessage(error)}`);
    pessoas = [];
  }
  if (!pessoas.length) {
    return salvarERevisar(
      r,
      ctx,
      "Não deu para carregar as pessoas do setor. Adicione quem acompanha à mão.",
    );
  }
  const novos = pessoas.filter((p) => !f.pessoas.some((x) => x.id === p.id));
  f.pessoas.push(...novos);
  f.pessoasDoSetor = novos.map((p) => p.id);
  return salvarERevisar(r, ctx);
}

async function acaoAnexos(ctx: Ctx) {
  const r = await rascunhoEmRevisao(ctx);
  if ("tela" in r) return r.tela;
  // "Selecionar tudo" ignora os bloqueados: marcar um anexo que o Suite vai
  // recusar so adiaria o erro para a hora de criar (regra do app).
  r.form!.anexos =
    C.lerParametro(ctx.evento, "modo") === "todos"
      ? r.preview!.anexos.filter((a) => !a.bloqueado).map((a) => a.id)
      : [];
  return salvarERevisar(r, ctx);
}

// "↻ Regenerar resumo (IA)": re-chama so o resumo, com o conteudo ja lido —
// nao relê o e-mail e nao mexe nos campos escolhidos (mesmo do app).
async function acaoRegenerar(ctx: Ctx) {
  const r = await rascunhoEmRevisao(ctx);
  if ("tela" in r) return r.tela;
  const p = r.preview!;
  if (!p.conteudo.trim()) {
    return salvarERevisar(r, ctx, "Não há conteúdo do e-mail para regenerar o resumo.");
  }
  await salvarRascunho(r);

  const aplicar = (alvo: Rascunho, resumo: Record<string, any>) => {
    alvo.preview!.ia = {
      resumo: resumo.resumo || "",
      pontos: Array.isArray(resumo.pontos_principais) ? resumo.pontos_principais : [],
      providencias: Array.isArray(resumo.providencias_sugeridas)
        ? resumo.providencias_sugeridas
        : [],
    };
    alvo.preview!.iaOk = true;
    const { corpo } = partesDescricao(alvo.preview!, clienteEscolhido(alvo));
    alvo.form!.corpo = corpo;
    alvo.corpoSistema = corpo;
  };

  let resultado: Record<string, any> | undefined;
  let falha: unknown;
  const tarefa = gerarResumoGemini({
    text: p.conteudo,
    origem: "email",
    fonte: "email",
    ramal: r.simular ? ramalDeTeste() : undefined,
    usuario: r.usuario?.nome || r.conta,
    itemId: itemDo(r),
  }).then(
    (x) => {
      resultado = x.resumo as unknown as Record<string, any>;
    },
    (error) => {
      falha = error;
    },
  );

  if (!(await terminouEm(tarefa, ESPERA_REGENERAR_MS))) {
    // A IA passou do tempo do Google: termina em segundo plano e grava no
    // rascunho mais novo (a pessoa pode ter mexido em outro campo nesse meio).
    emSegundoPlano(
      tarefa.then(async () => {
        if (!resultado) return;
        const atual = await cacheGet<Rascunho>(chaveRascunho(r.id)).catch(() => null);
        if (!atual || atual.criado) return;
        aplicar(atual, resultado);
        await salvarRascunho(atual);
      }),
    );
    return salvarERevisar(r, ctx, "A IA ainda está reescrevendo o resumo. Clique em Atualizar daqui a pouco.");
  }
  if (falha || !resultado) {
    console.warn(
      `[addon:gmail:regenerar] rasc=${r.id} falhou: ${getErrorMessage(falha || "sem resumo")}`,
    );
    return salvarERevisar(r, ctx, `Não foi possível regenerar o resumo: ${mensagemParaPessoa(falha)}`);
  }
  aplicar(r, resultado);
  return salvarERevisar(r, ctx);
}

async function acaoCriar(ctx: Ctx) {
  const r = await lerRascunho(C.lerParametro(ctx.evento, "rascunho"), ctx.conta);
  if (r.criado || r.status !== "pronto") {
    return C.resposta.atualizar(await telaDoRascunho(r, ctx));
  }
  absorverFormulario(r, ctx.evento);
  r.editando = undefined;
  r.resultados = [];
  await salvarRascunho(r);

  if (ctx.simular) return C.resposta.empurrar(await telaSimulada(r, ctx));

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

// 👍/👎 da revisao ("O resumo ficou bom?") e da tela de chamado criado.
async function acaoFeedback(ctx: Ctx) {
  const r = await lerRascunho(C.lerParametro(ctx.evento, "rascunho"), ctx.conta);
  const naRevisao = C.lerParametro(ctx.evento, "onde") === "revisao" && !r.criado;
  if (!naRevisao && !r.criado) return C.resposta.atualizar(await telaDoRascunho(r, ctx));
  if (naRevisao) {
    if (r.status !== "pronto") return C.resposta.atualizar(await telaDoRascunho(r, ctx));
    // O resto do formulario vem no mesmo clique: nao pode se perder.
    absorverFormulario(r, ctx.evento);
  }
  const nota = C.lerParametro(ctx.evento, "nota");
  const definir = (v: "up" | "down" | "abrindo") => {
    if (naRevisao) r.feedbackRevisao = v;
    else r.criado!.feedback = v;
  };
  const redesenhar = async () =>
    C.resposta.atualizar(naRevisao ? await telaRevisao(r, ctx) : telaCriado(r, ctx));

  if (nota === "down") {
    // 👎 abre os detalhes em vez de enviar: e no "o que errou" que esta a
    // informacao util para corrigir o prompt (mesma decisao do app).
    definir("abrindo");
    await salvarRascunho(r);
    return redesenhar();
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
    descEditada: corpoEditado(r),
  });
  definir(rating);
  await salvarRascunho(r);
  return redesenhar();
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

const ACOES: Record<string, (ctx: Ctx) => Promise<unknown>> = {
  inicio: acaoInicio,
  email: acaoEmail,
  abrir: acaoAbrir,
  preparar: acaoPreparar,
  atualizar: acaoAtualizar,
  editar: acaoEditar,
  buscar: acaoBuscar,
  escolher: acaoEscolher,
  remover: acaoRemover,
  "setor-pessoas": acaoSetorPessoas,
  campos: acaoCampos,
  anexos: acaoAnexos,
  regenerar: acaoRegenerar,
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

  const inicio = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const tratamento = tratarPedido(req, nome, acao);
  const estouro = new Promise<Resposta>((ok) => {
    timer = setTimeout(
      () =>
        ok({
          status: 200,
          corpo: C.resposta.empurrar(
            telaMensagem(
              "Demorou mais que o normal",
              "O Google só espera alguns segundos pela resposta, e desta vez passou. Tente de novo.",
            ),
          ),
          estourou: true,
        }),
      ORCAMENTO_RESPOSTA_MS,
    );
  });
  const resposta = await Promise.race([tratamento, estouro]);
  if (timer) clearTimeout(timer);

  const ms = Date.now() - inicio;
  if (resposta.estourou) {
    // O que estava em andamento (um "criar", por exemplo) termina mesmo assim;
    // a idempotencia do fluxo segura um segundo clique.
    emSegundoPlano(tratamento);
    console.error(
      `[addon:gmail:${nome}] passou de ${ORCAMENTO_RESPOSTA_MS}ms: respondeu "tente de novo" no lugar do 504`,
    );
  } else if (ms > 2000) {
    console.warn(`[addon:gmail:${nome}] lento: ${ms}ms`);
  }
  res.status(resposta.status).json(resposta.corpo);
}

interface Resposta {
  status: number;
  corpo: unknown;
  estourou?: boolean;
}

// Identidade + acao, devolvendo a resposta em vez de escrever no `res`: e o que
// permite o teto de tempo acima responder sozinho quando isto demora.
async function tratarPedido(
  req: Request,
  nome: string,
  acao: (ctx: Ctx) => Promise<unknown>,
): Promise<Resposta> {
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
      return { status: 401, corpo: { ok: false, error: { code: e.code, message: e.message } } };
    }
    return {
      status: 200,
      corpo: C.resposta.empurrar(
        telaMensagem("Não foi possível abrir o painel", e?.message || MSG_INESPERADO),
      ),
    };
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
    return { status: 200, corpo: await acao(ctx) };
  } catch (error) {
    console.error(
      `[addon:gmail:${nome}] conta=${conta} falhou: ` +
        `${error instanceof AppError ? error.code : "sem code"} ${getErrorMessage(error)}`,
    );
    return {
      status: 200,
      corpo: C.resposta.empurrar(telaMensagem("Algo deu errado", mensagemParaPessoa(error))),
    };
  }
}
