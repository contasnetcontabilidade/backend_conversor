import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { AppError, getErrorMessage } from "../lib/errors";
import { chatHabilitado, temEscopoChat } from "../services/gmailAuth";
import {
  chaveDaSelecao,
  garantirSecaoChamado,
  listarEspacos,
  listarEspacosDaSecao,
  listarMensagens,
  montarTextoSelecionado,
  obterMensagens,
  periodoLegivel,
  tamanhoPagina,
  type EspacoResumo,
} from "../services/chatApi";
import { resolverContaGoogle } from "../services/googleConta";
import {
  gerarResumoGemini,
  resumoVazio,
  type ResumoJson,
} from "../services/gemini";
import { fluxoCriarChamado } from "../services/chamadoFluxo";
import { montarRefs } from "../services/chamadoRefs";
import {
  getChatFeitos,
  getSelecaoChat,
  marcarChatFeito,
  salvarSelecaoChat,
} from "../services/store";
import {
  buscarSetores,
  buscarTipos,
  isDryRun,
  montarDescricaoChat,
  resolverAssuntoPorTexto,
  resolverClientePorMencao,
  resolverOrigemChat,
  type RefResolvida,
} from "../services/suite360";
import { ensureBodyObject, getOptionalString } from "../utils/request";

// Aba "Chat": abre chamado a partir de mensagens do Google Chat selecionadas
// pelo atendente. Espelha o gmail.controller de proposito — o preview devolve
// EXATAMENTE o mesmo shape do de e-mail para o modal de revisao do app ser
// reaproveitado sem reescrita.

const NS = "chat"; // namespace de idempotencia (o do e-mail e "gmail")
const MAX_SELECAO = Number(process.env.CHAT_MAX_SELECAO) || 200;

// Le um campo de ID que pode vir como string OU numero no JSON.
function campoId(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function listaDeStrings(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  return valor.map((v) => String(v || "").trim()).filter(Boolean);
}

function qs(req: Request, nome: string): string {
  const v = req.query[nome];
  return typeof v === "string" ? v.trim() : "";
}

// ---------------------------------------------------------------------------
// GET /chat/status — a conta ja autorizou o Chat?
// ---------------------------------------------------------------------------

// O app chama isto ao abrir a aba. Quem conectou a conta ANTES desta versao nao
// tem os escopos de Chat e precisa reconectar uma vez — nao e caso de borda, e a
// primeira experiencia da base inteira, entao o app precisa saber disso sem
// tomar um 403 no meio da tela.
export async function chatStatusController(req: Request, res: Response) {
  const email = await resolverContaGoogle(
    qs(req, "profileToken"),
    qs(req, "email"),
  );
  const habilitado = chatHabilitado();
  const temChat = habilitado
    ? await temEscopoChat(email).catch(() => false)
    : false;

  // So mexe na secao se a conta ja pode falar com o Chat.
  const secaoId = temChat
    ? await garantirSecaoChamado(email).catch(() => "")
    : "";

  res.status(200).json({
    ok: true,
    data: {
      conta: email,
      habilitado,
      temChat,
      secao: (process.env.CHAT_SECAO || "Chamado").trim() || "Chamado",
      secaoId,
      // O app usa este valor para paginar; assim da para cair de 100 para 50 por
      // variavel de ambiente, sem republicar o desktop.
      pageSize: tamanhoPagina(),
      reconectarUrl: "/api/gmail/oauth/start?chat=1",
    },
  });
}

// Barreira unica para as rotas de leitura: erro claro e acionavel em vez do 403
// cru do Google.
async function contaComChat(req: Request): Promise<string> {
  const email = await resolverContaGoogle(
    qs(req, "profileToken"),
    qs(req, "email"),
  );
  if (!chatHabilitado()) {
    throw new AppError({
      statusCode: 403,
      code: "CHAT_DESABILITADO",
      message: "A integracao com o Google Chat esta desligada no servidor.",
    });
  }
  const temChat = await temEscopoChat(email).catch(() => false);
  if (!temChat) {
    throw new AppError({
      statusCode: 403,
      code: "CHAT_SCOPE_MISSING",
      message:
        "Sua conta Google ainda nao liberou o acesso ao Chat. Reconecte em Configurar Perfil.",
    });
  }
  return email;
}

// ---------------------------------------------------------------------------
// GET /chat/spaces — conversas da secao "Chamado" (ou todas)
// ---------------------------------------------------------------------------

export async function chatSpacesController(req: Request, res: Response) {
  const email = await contaComChat(req);
  const fonte = qs(req, "fonte") || "secao";

  let espacos: EspacoResumo[];
  let proximaPagina = "";
  if (fonte === "todas") {
    const tipoRaw = qs(req, "tipo");
    const tipo =
      tipoRaw === "salas" || tipoRaw === "diretas" ? tipoRaw : "todos";
    const r = await listarEspacos(email, {
      tipo,
      pageToken: qs(req, "pageToken") || undefined,
    });
    espacos = r.espacos;
    proximaPagina = r.proximaPagina;
  } else {
    espacos = await listarEspacosDaSecao(email);
  }

  res.status(200).json({
    ok: true,
    data: {
      conta: email,
      fonte,
      secao: (process.env.CHAT_SECAO || "Chamado").trim() || "Chamado",
      espacos,
      proximaPagina,
    },
  });
}

// ---------------------------------------------------------------------------
// GET /chat/messages — uma pagina de mensagens da conversa
// ---------------------------------------------------------------------------

export async function chatMessagesController(req: Request, res: Response) {
  const email = await contaComChat(req);
  const spaceId = qs(req, "spaceId");
  if (!spaceId) {
    throw new AppError({
      statusCode: 400,
      code: "SPACE_ID_REQUIRED",
      message: "Informe a conversa (spaceId).",
    });
  }

  const pageSizeParam = Number(qs(req, "pageSize"));
  const pagina = await listarMensagens(email, spaceId, {
    pageSize:
      Number.isFinite(pageSizeParam) && pageSizeParam > 0
        ? pageSizeParam
        : undefined,
    pageToken: qs(req, "pageToken") || undefined,
    desde: qs(req, "desde") || undefined,
  });

  // Uma unica leitura de HASH marca a pagina inteira. Diferente do e-mail (que
  // guarda isso no localStorage de cada maquina), aqui e COMPARTILHADO: se um
  // colega ja abriu chamado daquelas mensagens, todo mundo ve.
  const feitos = await getChatFeitos(spaceId).catch(
    () => ({}) as Record<string, string>,
  );
  const mensagens = pagina.mensagens.map((m) => ({
    ...m,
    feito: Boolean(feitos[m.id]),
    protocolo: feitos[m.id] || "",
  }));

  res.status(200).json({
    ok: true,
    data: {
      conta: email,
      spaceId,
      mensagens,
      nextPageToken: pagina.proximaPagina || "",
    },
  });
}

// ---------------------------------------------------------------------------
// POST /chat/chamado/preview — rascunho do chamado a partir da selecao
// ---------------------------------------------------------------------------

export async function chatPreviewController(req: Request, res: Response) {
  const requestId = randomUUID();
  const body = ensureBodyObject(req.body);
  const profileToken = getOptionalString(body, "profileToken");
  const emailParam = getOptionalString(body, "email");
  const spaceId = getOptionalString(body, "spaceId");
  const geminiModel = getOptionalString(body, "geminiModel");
  const ramal = getOptionalString(body, "ramal");
  const usuario = getOptionalString(body, "usuario");
  const espacoNome = getOptionalString(body, "espacoNome");
  const setorIdPerfil = getOptionalString(body, "setorId");
  const setorNomePerfil = getOptionalString(body, "setorNome");
  const execIdPerfil = getOptionalString(body, "executorId");
  const execNomePerfil = getOptionalString(body, "executorNome");
  const messageIds = listaDeStrings(body.messageIds);

  if (!spaceId) {
    throw new AppError({
      statusCode: 400,
      code: "SPACE_ID_REQUIRED",
      message: "Informe a conversa (spaceId).",
    });
  }
  if (!messageIds.length) {
    throw new AppError({
      statusCode: 400,
      code: "MESSAGE_IDS_REQUIRED",
      message: "Selecione ao menos uma mensagem para gerar o chamado.",
    });
  }
  if (messageIds.length > MAX_SELECAO) {
    throw new AppError({
      statusCode: 422,
      code: "CHAT_SELECAO_EXCEDIDA",
      message: `Selecao muito grande (${messageIds.length}). Maximo de ${MAX_SELECAO} mensagens por chamado.`,
    });
  }
  // Um id de outra conversa entraria no chamado sem o usuario ver — recusa.
  const foraDoEspaco = messageIds.filter(
    (id) => !id.startsWith(`${spaceId}/messages/`),
  );
  if (foraDoEspaco.length) {
    throw new AppError({
      statusCode: 400,
      code: "MESSAGE_IDS_INVALIDOS",
      message: "Ha mensagens selecionadas que nao pertencem a esta conversa.",
    });
  }

  const email = await resolverContaGoogle(profileToken || "", emailParam);
  const chave = chaveDaSelecao(spaceId, messageIds);
  // (o "criar" recupera a selecao por chat:sel; a conta nao e consultada la,
  // entao gravar chat:acct era escrita morta e foi removida)
  // Guardado DEPOIS da leitura, com os ids efetivamente lidos (ver abaixo).

  const { mensagens: msgs, falharam } = await obterMensagens(
    email,
    spaceId,
    messageIds,
  );
  // Selecao PARCIAL e recusada: seguir com buraco geraria um chamado que parece
  // completo e nao e — e as mensagens perdidas ficariam marcadas como feitas.
  if (falharam.length) {
    throw new AppError({
      statusCode: 503,
      code: "CHAT_MENSAGENS_PARCIAIS",
      message: `Nao foi possivel ler ${falharam.length} das ${messageIds.length} mensagens marcadas. Tente de novo em instantes.`,
    });
  }
  if (!msgs.length) {
    throw new AppError({
      statusCode: 404,
      code: "CHAT_MENSAGENS_NAO_ENCONTRADAS",
      message:
        "Nao foi possivel ler as mensagens selecionadas. Recarregue a conversa e tente de novo.",
    });
  }

  await salvarSelecaoChat(
    chave,
    msgs.map((m) => m.id),
  ).catch(() => undefined);

  const sel = montarTextoSelecionado(msgs);
  const participantes = sel.participantes.join(", ");
  const periodo = periodoLegivel(sel.primeiraHora, sel.ultimaHora);
  const nomeConversa = espacoNome || "Conversa do Google Chat";

  const tiposDisponiveis = await buscarTipos().catch(() => []);

  // Lista de setores para a IA poder sugerir setores ADICIONAIS ao do perfil.

  const setoresDisponiveis = await buscarSetores().catch(() => []);

  // A IA e best-effort (o retry robusto ja mora no gerarResumoGemini): se ela
  // falhar, o chamado ainda abre com os campos vazios para preenchimento manual.
  let resumo: ResumoJson;
  let iaOk = true;
  try {
    ({ resumo } = await gerarResumoGemini({
      text: `Conversa: ${nomeConversa}\nParticipantes: ${participantes}\n\n${sel.texto}`,
      origem: "chat",
      model: geminiModel,
      assuntosDisponiveis: tiposDisponiveis.map((t) => ({
        id: t.id,
        nome: t.nome,
      })),
      setoresDisponiveis: setoresDisponiveis.map((s) => ({
        id: s.id,
        nome: s.nome,
      })),
      ramal,
      usuario,
      fonte: "chat",
      qtdMensagens: sel.qtd,
      itemId: chave,
    }));
  } catch (error) {
    iaOk = false;
    console.warn(
      `[chat:preview] req=${requestId} resumo falhou: ${getErrorMessage(
        error,
      )} — seguindo com campos vazios.`,
    );
    resumo = resumoVazio();
  }

  // Assunto: env fixo > escolha da IA (validada na lista) > match textual.
  const tipoEnv = (process.env.SUITE360_TIPO_APONTAMENTO_ID || "").trim();
  const escolhaIA = resumo.assunto_escolhido;
  const tipoNaLista = escolhaIA?.id
    ? tiposDisponiveis.find((t) => String(t.id) === String(escolhaIA.id))
    : undefined;
  let tipo: RefResolvida;
  if (tipoEnv) tipo = { id: tipoEnv, fonte: "env" };
  else if (tipoNaLista)
    tipo = { id: tipoNaLista.id, nome: tipoNaLista.nome, fonte: "ia" };
  else
    tipo = await resolverAssuntoPorTexto(
      resumo.assunto_sugerido || resumo.titulo,
    );

  const origem = await resolverOrigemChat();

  // Setor/executor: vem do PERFIL (enviado pelo app). Fallback: env; senao ausente.
  const setorEnv = (process.env.SUITE360_SETOR_ID || "").trim();
  const execEnv = (process.env.SUITE360_EXECUTOR_ID || "").trim();
  const setor: RefResolvida = setorIdPerfil
    ? { id: setorIdPerfil, nome: setorNomePerfil || undefined, fonte: "perfil" }
    : setorEnv
      ? { id: setorEnv, fonte: "env" }
      : { fonte: "ausente" };
  const executor: RefResolvida = execIdPerfil
    ? { id: execIdPerfil, nome: execNomePerfil || undefined, fonte: "perfil" }
    : execEnv
      ? { id: execEnv, fonte: "env" }
      : { fonte: "ausente" };

  const porMencao = await resolverClientePorMencao(
    resumo.cliente_mencionado,
    resumo.cliente_alternativas,
  );
  const cliente = porMencao
    ? { status: "encontrado" as const, cliente: porMencao, via: "ia_mencao" }
    : { status: "nao_encontrado" as const };
  const clienteEncontrado =
    cliente.status === "encontrado" ? cliente.cliente : undefined;

  const atendente = usuario || execNomePerfil || "";
  const descricao = montarDescricaoChat({
    razaoSocial: clienteEncontrado?.razao_social,
    cnpj: clienteEncontrado?.cnpj,
    espaco: nomeConversa,
    participantes,
    periodo,
    qtdMensagens: sel.qtd,
    atendente,
    idChat: chave,
    resumo: resumo.resumo,
    pontosPrincipais: resumo.pontos_principais,
    providencias: resumo.providencias_sugeridas,
    conversa: sel.texto,
  });

  const refs = await montarRefs({
    resumo,
    tipo,
    origem,
    setor,
    executor,
    clienteId: clienteEncontrado?.id,
  });

  console.log(
    `[chat:preview] req=${requestId} chave=${chave} msgs=${sel.qtd} ` +
      `conta=${email} cliente=${clienteEncontrado?.id || cliente.status} tipo=${
        tipo.id || tipo.fonte
      } setor=${setor.id || setor.fonte} executor=${executor.id || executor.fonte}`,
  );

  res.status(200).json({
    ok: true,
    data: {
      requestId,
      fonte: "chat",
      spaceId,
      chaveChat: chave,
      messageIds,
      qtdMensagens: sel.qtd,
      dryRun: isDryRun(),
      iaOk,
      chat: {
        conta: email,
        espaco: nomeConversa,
        participantes,
        periodo,
        snippet: sel.texto.slice(0, 180),
      },
      // Mesmas CHAVES que o preview de e-mail usa: e isto que faz o modal de
      // revisao do app funcionar sem nenhuma alteracao no revPreencher.
      chamada: {
        tipo: "chat",
        dataHora: periodo,
        remetente: participantes
          ? `${participantes} (${sel.qtd} mensagem${sel.qtd > 1 ? "s" : ""})`
          : `${sel.qtd} mensagem(ns)`,
        assunto: nomeConversa,
        atendente,
        idEmail: chave,
      },
      ia: resumo,
      transcricao: sel.texto,
      cliente,
      refs,
      descricao,
    },
  });
}

// ---------------------------------------------------------------------------
// POST /chat/chamado/criar — cria o chamado (dry-run + idempotencia)
// ---------------------------------------------------------------------------

// Substituto do "remover marcador" do e-mail: nao ha write no Chat, entao em vez
// de tirar um rotulo, registramos no Redis quais mensagens ja viraram chamado.
async function marcarFeitoPosCriar(
  chave: string,
  spaceId: string,
  messageIds: string[],
  protocolo: string,
): Promise<void> {
  if (!chave) return;
  // A chave e "<spaceId-sem-prefixo>:<hash>", entao o espaco esta ali mesmo
  // quando o app nao manda o campo (ex.: modal reaberto por outro caminho).
  const espaco = spaceId || `spaces/${chave.split(":")[0]}`;
  let ids = messageIds;
  // O app pode nao reenviar a lista no "criar"; ela ficou salva no preview.
  if (!ids.length) ids = await getSelecaoChat(chave).catch(() => []);
  if (!ids.length) return;
  await marcarChatFeito(espaco, ids, protocolo).catch(() => undefined);
}

export async function chatCriarController(req: Request, res: Response) {
  const body = ensureBodyObject(req.body);
  const spaceId = getOptionalString(body, "spaceId") || "";
  const messageIds = listaDeStrings(body.messageIds);
  // Chave = hash da selecao (vem do preview). Sem ela, recalcula dos ids.
  const chave =
    getOptionalString(body, "chaveChat") ||
    (spaceId && messageIds.length ? chaveDaSelecao(spaceId, messageIds) : "");

  await fluxoCriarChamado({
    res,
    requestId: randomUUID(),
    body,
    ns: NS,
    chave,
    fonteCusto: "chat",
    logTag: "chat:criar",
    msgJaExistia: (p) => `Chamado ja existente para estas mensagens: ${p}`,
    // Marcar as mensagens como "ja viraram chamado" e compartilhado entre
    // atendentes, entao so vale quando o chamado existe de verdade.
    depois: async ({ dryRun, protocolo }) => {
      if (dryRun) return;
      await marcarFeitoPosCriar(chave, spaceId, messageIds, protocolo);
    },
  });
}
