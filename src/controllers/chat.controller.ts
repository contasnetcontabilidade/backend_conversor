import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { AppError, getErrorMessage } from "../lib/errors";
import { chatHabilitado, temEscopoChat } from "../services/gmailAuth";
import {
  baixarAnexoChat,
  chaveDaSelecao,
  garantirSecaoChamado,
  listarEspacos,
  listarEspacosDaSecao,
  listarMensagens,
  montarTextoSelecionado,
  obterMensagens,
  periodoLegivel,
  tamanhoAnexoChat,
  tamanhoPagina,
  type AnexoChat,
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
  getContaDoItem,
  getSelecaoChat,
  marcarChatFeito,
  salvarContaDoItem,
  salvarSelecaoChat,
} from "../services/store";
import {
  ANEXO_TAMANHO_MAX_BYTES,
  buscarSetores,
  buscarTipos,
  formatarBytes,
  isDryRun,
  montarDescricaoChat,
  resolverAssuntoPorTexto,
  resolverClientePorMencao,
  resolverOrigemChat,
  type AnexoChamado,
  type RefResolvida,
} from "../services/suite360";
import {
  previaApresentacao,
  previaCsv,
  previaDocumento,
  previaPlanilha,
  tipoConversao,
} from "../services/anexoPrevia";
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

// ---------------------------------------------------------------------------
// Anexos das mensagens selecionadas
// ---------------------------------------------------------------------------

function horaCurta(iso: string): { data: string; hora: string } {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return { data: "", hora: "" };
  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", ...opts });
  const [dia, mes, ano] = fmt({
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).split("/");
  return {
    data: `${ano}-${mes}-${dia}`,
    hora: fmt({ hour: "2-digit", minute: "2-digit" }).replace(":", ""),
  };
}

// Print colado no Chat chega SEMPRE como "image.png" — foi o nome mais comum na
// varredura dos espacos. Numa lista de cinco, todos iguais, ninguem sabe qual e
// qual, e dentro do chamado cinco arquivos homonimos e pior ainda.
//
// Por isso o nome generico e trocado por data-hora-autor. Nome proprio
// (relatorio.xlsx, contrato.pdf) e mantido: ali o nome carrega informacao que
// a data nao substitui.
const NOME_GENERICO = /^(image|imagem|captura|screenshot|foto)[-_ ]?\d*$/i;

function nomeParaSuite(a: AnexoChat): string {
  const ponto = a.nome.lastIndexOf(".");
  const base = ponto > 0 ? a.nome.slice(0, ponto) : a.nome;
  const ext = ponto > 0 ? a.nome.slice(ponto) : "";
  if (!NOME_GENERICO.test(base)) return a.nome;
  const { data, hora } = horaCurta(a.hora);
  // Acento e espaco viram problema em nome de arquivo baixado depois.
  const autor = a.autor
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")[0];
  const partes = [data, hora, autor].filter(Boolean);
  return partes.length ? `${partes.join("-")}${ext}` : a.nome;
}

// Rotulo da LISTA (o que a pessoa le na tela). Mantem o nome original a vista e
// acrescenta quem mandou e quando — o que distingue um print do outro.
function rotuloAnexo(a: AnexoChat): string {
  const { hora } = horaCurta(a.hora);
  const quando = hora ? `${hora.slice(0, 2)}:${hora.slice(2)}` : "";
  const cauda = [a.autor, quando].filter(Boolean).join(", ");
  return cauda ? `${a.nome} — ${cauda}` : a.nome;
}

// Formato que vai para a tela. As sondagens de tamanho vao em PARALELO: cada
// uma custa uma ida e volta (~0,5s) e nenhum byte de corpo, entao em serie so
// somaria espera.
async function anexosChatParaApp(email: string, anexos: AnexoChat[]) {
  const tamanhos = await Promise.all(
    anexos.map((a) =>
      tamanhoAnexoChat(email, a.resourceName).catch(() => -1),
    ),
  );
  return anexos.map((a, i) => {
    const tamanho = tamanhos[i];
    // tamanho -1 = a sondagem falhou. NAO bloqueia: barrar por falta de
    // informacao esconderia um anexo bom. O limite ainda e cobrado na criacao.
    const excede = tamanho >= 0 && tamanho > ANEXO_TAMANHO_MAX_BYTES;
    return {
      id: a.id,
      nome: rotuloAnexo(a),
      mime: a.mime,
      tamanho: Math.max(tamanho, 0),
      tamanhoTexto: tamanho >= 0 ? formatarBytes(tamanho) : "",
      bloqueado: excede,
      motivo: excede
        ? `${formatarBytes(tamanho)} — acima do limite de ` +
          `${formatarBytes(ANEXO_TAMANHO_MAX_BYTES)} do Suite`
        : "",
    };
  });
}

// Relê as mensagens e devolve os anexos delas. Serve ao preview e, no criar e no
// visualizador, para CONFERIR o que o app pediu em vez de confiar na tela.
async function anexosDaSelecao(
  email: string,
  spaceId: string,
  messageIds: string[],
): Promise<AnexoChat[]> {
  if (!spaceId || !messageIds.length) return [];
  const { mensagens } = await obterMensagens(email, spaceId, messageIds);
  return mensagens.flatMap((m) => m.anexos || []);
}

// Conta do Google desta selecao. Gravada no preview (ver chat:acct la).
async function contaDaSelecao(chave: string): Promise<string> {
  const conta = await getContaDoItem(chave, NS).catch(() => null);
  if (!conta) {
    throw new AppError({
      statusCode: 400,
      code: "CHAT_CONTA_DESCONHECIDA",
      message:
        "Não foi possível identificar a conta do Google desta conversa para baixar os anexos. Feche e abra o chamado de novo.",
    });
  }
  return conta;
}

// Baixa o que a pessoa marcou. Mesmas regras do Gmail: um de cada vez (memoria),
// limite do Suite reconferido aqui, e qualquer falha derruba a criacao COM o
// nome do arquivo — a API do Suite nao tem endpoint para anexar depois.
async function resolverAnexosChatEscolhidos(
  escolhidos: string[],
  chave: string,
  spaceId: string,
  messageIds: string[],
): Promise<AnexoChamado[]> {
  const conta = await contaDaSelecao(chave);
  const ids = messageIds.length
    ? messageIds
    : await getSelecaoChat(chave).catch(() => [] as string[]);
  const porId = new Map(
    (await anexosDaSelecao(conta, spaceId, ids)).map((a) => [a.id, a]),
  );

  const saida: AnexoChamado[] = [];
  for (const id of escolhidos) {
    const anexo = porId.get(id);
    if (!anexo) {
      throw new AppError({
        statusCode: 422,
        code: "CHAT_ANEXO_NAO_ENCONTRADO",
        message:
          "Um dos anexos escolhidos não está mais nesta conversa. Feche e abra o chamado de novo para atualizar a lista.",
        details: { id },
      });
    }
    let bytes: Buffer;
    try {
      bytes = await baixarAnexoChat(conta, anexo.resourceName);
    } catch (error) {
      throw new AppError({
        statusCode: 502,
        code: "CHAT_ANEXO_FALHOU",
        message:
          `Não foi possível baixar o anexo "${anexo.nome}" do Chat. ` +
          "O chamado não foi criado.",
        details: { anexo: anexo.nome, causa: getErrorMessage(error) },
      });
    }
    // Cobrado aqui tambem: no Chat o tamanho da lista veio de sondagem, que
    // pode ter falhado. Este e o unico ponto onde o tamanho e certo.
    if (bytes.length > ANEXO_TAMANHO_MAX_BYTES) {
      throw new AppError({
        statusCode: 422,
        code: "CHAT_ANEXO_GRANDE",
        message:
          `O anexo "${anexo.nome}" tem ${formatarBytes(bytes.length)} e passa ` +
          `do limite de ${formatarBytes(ANEXO_TAMANHO_MAX_BYTES)} do Suite. ` +
          "Desmarque esse anexo para criar o chamado.",
        details: { anexo: anexo.nome },
      });
    }
    saida.push({
      nome: nomeParaSuite(anexo),
      conteudo_base64: bytes.toString("base64"),
    });
  }
  return saida;
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
  // chat:acct VOLTOU. Foi removido um dia como escrita morta, e estava certo na
  // epoca: o "criar" so precisava da selecao. Agora ele baixa os anexos
  // escolhidos e precisa da conta do Google — e o corpo do "criar" nao carrega
  // profileToken. Nao remover de novo sem checar isto.
  await salvarContaDoItem(chave, email, NS).catch(() => undefined);

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
        categoria: t.extra,
      })),
      setoresDisponiveis: setoresDisponiveis.map((s) => ({
        id: s.id,
        nome: s.nome,
      })),
      quemRegistra: {
        nome: execNomePerfil || usuario,
        setor: setorNomePerfil,
      },
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
      anexos: await anexosChatParaApp(
        email,
        msgs.flatMap((m) => m.anexos || []),
      ),
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

// ---------------------------------------------------------------------------
// GET /chat/anexo e /chat/anexo/previa — visualizacao antes de criar
// ---------------------------------------------------------------------------

// Resolve QUAL anexo a query pede, conferindo que ele pertence mesmo a esta
// selecao. Sem isso, um id qualquer viraria um download arbitrario do Chat.
async function anexoChatDaQuery(req: Request) {
  const id = qs(req, "id");
  const chave = qs(req, "chaveChat");
  const spaceId = qs(req, "spaceId");
  if (!id || !chave) {
    throw new AppError({
      statusCode: 400,
      code: "ANEXO_ID_REQUIRED",
      message: "Informe o id do anexo e a conversa.",
    });
  }

  const conta = await contaDaSelecao(chave);
  const ids = await getSelecaoChat(chave).catch(() => [] as string[]);
  // O spaceId vem na query, mas a chave ja o carrega como prefixo — serve de
  // reserva quando o app nao manda o campo.
  const espaco = spaceId || `spaces/${chave.split(":")[0]}`;
  const anexo = (await anexosDaSelecao(conta, espaco, ids)).find(
    (a) => a.id === id,
  );
  if (!anexo) {
    throw new AppError({
      statusCode: 404,
      code: "CHAT_ANEXO_NAO_ENCONTRADO",
      message: "Anexo não encontrado nesta conversa.",
    });
  }
  return { conta, anexo };
}

export async function chatAnexoController(req: Request, res: Response) {
  const { conta, anexo } = await anexoChatDaQuery(req);
  const bytes = await baixarAnexoChat(conta, anexo.resourceName);
  // O mime vem do metadado: o download do Chat responde octet-stream para tudo.
  res.setHeader("Content-Type", anexo.mime);
  res.setHeader("Content-Length", String(bytes.length));
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(anexo.nome)}`,
  );
  res.status(200).send(bytes);
}

export async function chatAnexoPreviaController(req: Request, res: Response) {
  const { conta, anexo } = await anexoChatDaQuery(req);
  const conversao = tipoConversao(anexo.mime, anexo.nome);
  if (!conversao) {
    throw new AppError({
      statusCode: 422,
      code: "ANEXO_SEM_PREVIA",
      message: `Não há pré-visualização para "${anexo.nome}".`,
    });
  }
  const bytes = await baixarAnexoChat(conta, anexo.resourceName);
  const previa =
    conversao === "planilha"
      ? await previaPlanilha(bytes, qs(req, "aba") || undefined)
      : conversao === "csv"
        ? await previaCsv(bytes)
        : conversao === "apresentacao"
          ? await previaApresentacao(bytes)
          : await previaDocumento(bytes);

  res.status(200).json({ ok: true, data: { nome: anexo.nome, ...previa } });
}

export async function chatCriarController(req: Request, res: Response) {
  const body = ensureBodyObject(req.body);
  const spaceId = getOptionalString(body, "spaceId") || "";
  const messageIds = listaDeStrings(body.messageIds);
  // Chave = hash da selecao (vem do preview). Sem ela, recalcula dos ids.
  const chave =
    getOptionalString(body, "chaveChat") ||
    (spaceId && messageIds.length ? chaveDaSelecao(spaceId, messageIds) : "");
  // So os identificadores trafegam: os bytes vao do Google direto ao backend.
  const anexosEscolhidos = listaDeStrings(body.anexosEscolhidos);

  await fluxoCriarChamado({
    res,
    requestId: randomUUID(),
    body,
    ns: NS,
    chave,
    fonteCusto: "chat",
    logTag: "chat:criar",
    msgJaExistia: (p) => `Chamado ja existente para estas mensagens: ${p}`,
    anexos: anexosEscolhidos.length
      ? () =>
          resolverAnexosChatEscolhidos(
            anexosEscolhidos,
            chave,
            spaceId,
            messageIds,
          )
      : undefined,
    // Marcar as mensagens como "ja viraram chamado" e compartilhado entre
    // atendentes, entao so vale quando o chamado existe de verdade.
    depois: async ({ dryRun, protocolo }) => {
      if (dryRun) return;
      await marcarFeitoPosCriar(chave, spaceId, messageIds, protocolo);
    },
  });
}
