import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { AppError, getErrorMessage } from "../lib/errors";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  temEscopoChat,
} from "../services/gmailAuth";
import { garantirSecaoChamado } from "../services/chatApi";
import {
  garantirMarcador,
  listarEmailsMarcados,
  obterEmail,
  obterThread,
  removerMarcadorDaThread,
  removerMarcadorDoEmail,
} from "../services/gmailApi";
import {
  getContaDoEmail,
  salvarContaDoEmail,
  setPerfilToken,
} from "../services/store";
import { resolverContaGoogle } from "../services/googleConta";
import {
  gerarResumoGemini,
  resumoVazio,
  type ResumoJson,
} from "../services/gemini";
import { fluxoCriarChamado } from "../services/chamadoFluxo";
import { montarRefs } from "../services/chamadoRefs";
import {
  buscarSetores,
  buscarTipos,
  isDryRun,
  montarDescricaoEmail,
  resolverAssuntoPorTexto,
  resolverClientePorMencao,
  resolverOrigemEmail,
  type RefResolvida,
} from "../services/suite360";
import { ensureBodyObject, getOptionalString } from "../utils/request";

// ---------------------------------------------------------------------------
// Helpers locais
// ---------------------------------------------------------------------------

function paginaHtml(titulo: string, mensagem: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${titulo}</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#0f2135;color:#eef4fb;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#14212f;border:1px solid #24374b;border-radius:16px;padding:32px 36px;
max-width:460px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.5)}
h1{font-size:1.3rem;margin:0 0 10px;color:#3f8fe0}p{color:#d3e0ee;line-height:1.6;margin:0}</style>
</head><body><div class="card"><h1>${titulo}</h1><p>${mensagem}</p></div></body></html>`;
}

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

// ---------------------------------------------------------------------------
// OAuth (por usuario) — o app abre estas paginas numa janela e captura o token
// ---------------------------------------------------------------------------

export async function gmailOAuthStartController(req: Request, res: Response) {
  const state = (process.env.GMAIL_OAUTH_STATE || randomUUID()).trim();
  // ?chat=1 forca os escopos do Google Chat no consentimento (e o que o botao
  // "Reconectar conta Google" da aba Chat usa); ?chat=0 pede so o Gmail.
  const chatParam =
    typeof req.query.chat === "string" ? req.query.chat.trim() : "";
  const comChat = chatParam ? chatParam !== "0" : undefined;
  res.redirect(buildAuthorizeUrl(state, { comChat }));
}

export async function gmailOAuthCallbackController(
  req: Request,
  res: Response,
) {
  const erro = typeof req.query.error === "string" ? req.query.error : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (erro) {
    res
      .status(400)
      .type("html")
      .send(paginaHtml("Falha ao conectar", `Autorizacao negada (${erro}).`));
    return;
  }
  if (!code) {
    res
      .status(400)
      .type("html")
      .send(paginaHtml("Falha ao conectar", "Codigo de autorizacao ausente."));
    return;
  }
  const { email } = await exchangeCodeForTokens(code);
  // Cria o marcador "Chamado" na conta assim que ela conecta (best-effort).
  await garantirMarcador(email).catch(() => undefined);
  // Mesma ideia no Google Chat: cria a SECAO "Chamado" na barra lateral, para o
  // usuario so precisar arrastar as conversas para la. So tenta se a conta
  // realmente autorizou o Chat — senao seria um 403 garantido a cada login.
  if (await temEscopoChat(email).catch(() => false)) {
    await garantirSecaoChamado(email).catch(() => undefined);
  }
  const profileToken = randomUUID();
  await setPerfilToken(profileToken, email);
  // Redireciona para uma pagina que o app captura (token + e-mail na URL).
  res.redirect(
    `/api/gmail/oauth/done?token=${encodeURIComponent(
      profileToken,
    )}&email=${encodeURIComponent(email)}`,
  );
}

export async function gmailOAuthDoneController(req: Request, res: Response) {
  const email = typeof req.query.email === "string" ? req.query.email : "";
  res
    .status(200)
    .type("html")
    .send(
      paginaHtml(
        "Conta conectada",
        `A conta <b>${email}</b> foi conectada. Pode fechar esta janela.`,
      ),
    );
}

// ---------------------------------------------------------------------------
// GET /gmail/emails?profileToken= — lista os e-mails marcados
// ---------------------------------------------------------------------------

export async function gmailEmailsController(req: Request, res: Response) {
  const profileToken =
    typeof req.query.profileToken === "string"
      ? req.query.profileToken.trim()
      : "";
  const emailParam =
    typeof req.query.email === "string" ? req.query.email.trim() : "";
  const email = await resolverContaGoogle(profileToken, emailParam);
  const emails = await listarEmailsMarcados(email);
  res.status(200).json({ ok: true, data: { conta: email, emails } });
}

// ---------------------------------------------------------------------------
// POST /gmail/chamado/preview — monta o rascunho do chamado a partir do e-mail
// ---------------------------------------------------------------------------

export async function gmailPreviewController(req: Request, res: Response) {
  const requestId = randomUUID();
  const body = ensureBodyObject(req.body);
  const profileToken = getOptionalString(body, "profileToken");
  const messageId = getOptionalString(body, "messageId");
  const threadId = getOptionalString(body, "threadId");
  const geminiModel = getOptionalString(body, "geminiModel");
  const ramal = getOptionalString(body, "ramal");
  const usuario = getOptionalString(body, "usuario");
  const setorIdPerfil = getOptionalString(body, "setorId");
  const setorNomePerfil = getOptionalString(body, "setorNome");
  const execIdPerfil = getOptionalString(body, "executorId");
  const execNomePerfil = getOptionalString(body, "executorNome");

  if (!messageId && !threadId) {
    throw new AppError({
      statusCode: 400,
      code: "MESSAGE_ID_REQUIRED",
      message: "Informe o threadId ou messageId do e-mail.",
    });
  }
  const emailParam = getOptionalString(body, "email");
  const email = await resolverContaGoogle(profileToken || "", emailParam);

  // Chave para idempotencia/marcador/conta: threadId (conversa inteira) quando
  // houver; senao o messageId (e-mail unico). Guarda a conta para o "criar".
  const chave = threadId || messageId!;
  await salvarContaDoEmail(chave, email).catch(() => undefined);

  // Le a conversa inteira (thread, todas as mensagens juntas) ou um e-mail unico.
  let de: string;
  let assunto: string;
  let dataHora: string;
  let corpoTexto: string;
  let snippet: string;
  let qtdMensagens = 1;
  if (threadId) {
    const thread = await obterThread(email, threadId);
    qtdMensagens = thread.count;
    const remet = thread.remetentes.length
      ? thread.remetentes.join(", ")
      : thread.from;
    de = qtdMensagens > 1 ? `${remet} (${qtdMensagens} mensagens)` : remet;
    assunto = thread.subject;
    dataHora = thread.date;
    corpoTexto = thread.corpo;
    snippet = corpoTexto.slice(0, 180);
  } else {
    const msg = await obterEmail(email, messageId!);
    de = msg.from;
    assunto = msg.subject;
    dataHora = msg.date;
    corpoTexto = msg.corpo;
    snippet = msg.snippet;
  }

  const tiposDisponiveis = await buscarTipos().catch(() => []);

  // Lista de setores para a IA poder sugerir setores ADICIONAIS ao do perfil.

  const setoresDisponiveis = await buscarSetores().catch(() => []);

  // A IA e best-effort (retry robusto ja no gerarResumoGemini).
  let resumo: ResumoJson;
  let iaOk = true;
  try {
    ({ resumo } = await gerarResumoGemini({
      text: `Assunto: ${assunto}\nRemetente: ${de}\n\n${corpoTexto}`,
      origem: "email",
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
      fonte: "email",
      qtdMensagens,
      // Mesma chave da idempotencia (thread > mensagem): amarra o custo desta
      // IA ao chamado que sair dela.
      itemId: chave,
    }));
  } catch (error) {
    iaOk = false;
    console.warn(
      `[gmail:preview] req=${requestId} resumo falhou: ${getErrorMessage(
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

  const origem = await resolverOrigemEmail();

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

  // Cliente: pela mencao (CNPJ/nome) que a IA captou; senao manual no modal.
  const porMencao = await resolverClientePorMencao(
    resumo.cliente_mencionado,
    resumo.cliente_alternativas,
  );
  const cliente = porMencao
    ? { status: "encontrado" as const, cliente: porMencao, via: "ia_mencao" }
    : { status: "nao_encontrado" as const };
  const clienteEncontrado =
    cliente.status === "encontrado" ? cliente.cliente : undefined;

  const descricao = montarDescricaoEmail({
    razaoSocial: clienteEncontrado?.razao_social,
    cnpj: clienteEncontrado?.cnpj,
    remetente: de,
    assunto: assunto,
    dataHora: dataHora,
    atendente: usuario || execNomePerfil || "",
    idEmail: chave,
    resumo: resumo.resumo,
    pontosPrincipais: resumo.pontos_principais,
    providencias: resumo.providencias_sugeridas,
    corpo: corpoTexto,
  });

  // Sugestoes novas da IA (titulo, competencia, prioridade, setores e pessoas
  // vinculadas, "ja resolvido") + campos personalizados do assunto.
  const refs = await montarRefs({
    resumo,
    tipo,
    origem,
    setor,
    executor,
    clienteId: clienteEncontrado?.id,
  });

  console.log(
    `[gmail:preview] req=${requestId} chave=${chave} msgs=${qtdMensagens} ` +
      `conta=${email} cliente=${clienteEncontrado?.id || cliente.status} tipo=${
        tipo.id || tipo.fonte
      } setor=${setor.id || setor.fonte} executor=${executor.id || executor.fonte}`,
  );

  res.status(200).json({
    ok: true,
    data: {
      requestId,
      fonte: "email",
      messageId: messageId || "",
      threadId: threadId || "",
      qtdMensagens,
      dryRun: isDryRun(),
      iaOk,
      email: {
        conta: email,
        de,
        assunto,
        data: dataHora,
        snippet,
      },
      chamada: {
        tipo: "email",
        dataHora,
        remetente: de,
        assunto,
        atendente: usuario || execNomePerfil || "",
        idEmail: chave,
      },
      ia: resumo,
      transcricao: corpoTexto,
      cliente,
      refs,
      descricao,
    },
  });
}

// ---------------------------------------------------------------------------
// POST /gmail/chamado/criar — cria o chamado (dry-run + idempotencia por messageId)
// ---------------------------------------------------------------------------

// Remove o marcador do e-mail apos o chamado ser criado (best-effort). A conta
// foi guardada no preview (gmail:acct:messageId).
async function removerMarcadorPosCriar(
  chave?: string,
  threadId?: string,
): Promise<void> {
  if (!chave) return;
  const conta = await getContaDoEmail(chave).catch(() => null);
  if (!conta) return;
  if (threadId) {
    // Remove o marcador de todas as mensagens da conversa de uma vez.
    await removerMarcadorDaThread(conta, threadId).catch(() => undefined);
  } else {
    await removerMarcadorDoEmail(conta, chave).catch(() => undefined);
  }
}

export async function gmailCriarController(req: Request, res: Response) {
  const body = ensureBodyObject(req.body);
  const messageId = getOptionalString(body, "messageId");
  const threadId = getOptionalString(body, "threadId");
  // Chave de idempotencia/marcador: threadId (conversa) quando houver; senao msgId.
  const chave = threadId || messageId || "";

  await fluxoCriarChamado({
    res,
    requestId: randomUUID(),
    body,
    ns: "gmail",
    chave,
    fonteCusto: "email",
    logTag: "gmail:criar",
    msgJaExistia: (p) => `Chamado ja existente para esta conversa: ${p}`,
    // O marcador so sai quando o chamado existe DE VERDADE: em dry-run o
    // e-mail tem que continuar aparecendo na lista para poder ser retestado.
    depois: async ({ dryRun }) => {
      if (dryRun) return;
      await removerMarcadorPosCriar(chave, threadId);
    },
  });
}
