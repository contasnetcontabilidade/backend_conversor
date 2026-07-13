import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { AppError, getErrorMessage } from "../lib/errors";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
} from "../services/gmailAuth";
import { listarEmailsMarcados, obterEmail } from "../services/gmailApi";
import {
  getChamadoCriado,
  getEmailByToken,
  getGmailAccess,
  getGmailRefresh,
  liberarCriacao,
  reservarCriacao,
  salvarChamadoCriado,
  setPerfilToken,
} from "../services/store";
import { gerarResumoGemini, type ResumoJson } from "../services/gemini";
import {
  buscarTipos,
  criarChamado,
  isDryRun,
  montarDescricaoEmail,
  resolverAssuntoPorTexto,
  resolverClientePorMencao,
  resolverOrigem,
  validarChamadoBody,
  type ChamadoBody,
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

export async function gmailOAuthStartController(_req: Request, res: Response) {
  const state = (process.env.GMAIL_OAUTH_STATE || randomUUID()).trim();
  res.redirect(buildAuthorizeUrl(state));
}

export async function gmailOAuthCallbackController(req: Request, res: Response) {
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

// [DIAGNOSTICO TEMPORARIO] inspeciona o estado do storage do Gmail.
//   ?email=...   -> mostra se a conta tem refresh/access token salvos
//   ?token=...   -> mostra se um profileToken resolve para um e-mail
//   (sem params) -> testa o round-trip basico do storage
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function gmailDiagController(req: Request, res: Response) {
  const email = String(req.query.email || "").trim().toLowerCase();
  const token = String(req.query.token || "").trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any = { ok: true };

  const k = "diagtok-" + randomUUID();
  await setPerfilToken(k, "diag@teste.com");
  out.roundTripOk = (await getEmailByToken(k)) === "diag@teste.com";

  if (token) {
    out.token = {
      prefixo: token.slice(0, 8) + "…",
      resolveEmail: await getEmailByToken(token).catch(() => null),
    };
  }
  if (email) {
    out.conta = {
      email,
      temRefresh: Boolean(await getGmailRefresh(email).catch(() => null)),
      temAccess: Boolean(await getGmailAccess(email).catch(() => null)),
    };
    // Chama a API do Gmail e devolve o erro CRU do Google (pra ver o motivo do 403).
    try {
      const at = await getValidAccessToken(email);
      const r = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        { headers: { Authorization: `Bearer ${at}` } },
      );
      const body = await r.text();
      out.gmailTest = { status: r.status, body: body.slice(0, 600) };
    } catch (e) {
      out.gmailTest = { erro: getErrorMessage(e) };
    }
  }
  res.status(200).json(out);
}

// ---------------------------------------------------------------------------
// GET /gmail/emails?profileToken= — lista os e-mails marcados
// ---------------------------------------------------------------------------

// Resolve a conta Google do usuario: 1) pelo profileToken (opaco); 2) fallback
// pelo e-mail enviado pelo app, se essa conta tiver tokens salvos (esta conectada).
async function resolverContaGmail(
  profileToken?: string,
  emailParam?: string,
): Promise<string> {
  let email = profileToken
    ? await getEmailByToken(profileToken).catch(() => null)
    : null;
  if (!email && emailParam) {
    const e = String(emailParam).trim().toLowerCase();
    const conectada =
      (await getGmailRefresh(e).catch(() => null)) ||
      (await getGmailAccess(e).catch(() => null));
    if (e && conectada) email = e;
  }
  if (!email) {
    throw new AppError({
      statusCode: 401,
      code: "GMAIL_PERFIL_NAO_CONECTADO",
      message: "Conta Google nao conectada. Conecte em Configurar Perfil.",
    });
  }
  return email;
}

export async function gmailEmailsController(req: Request, res: Response) {
  const profileToken =
    typeof req.query.profileToken === "string"
      ? req.query.profileToken.trim()
      : "";
  const emailParam =
    typeof req.query.email === "string" ? req.query.email.trim() : "";
  const email = await resolverContaGmail(profileToken, emailParam);
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
  const geminiModel = getOptionalString(body, "geminiModel");
  const ramal = getOptionalString(body, "ramal");
  const usuario = getOptionalString(body, "usuario");
  const setorIdPerfil = getOptionalString(body, "setorId");
  const setorNomePerfil = getOptionalString(body, "setorNome");
  const execIdPerfil = getOptionalString(body, "executorId");
  const execNomePerfil = getOptionalString(body, "executorNome");

  if (!messageId) {
    throw new AppError({
      statusCode: 400,
      code: "MESSAGE_ID_REQUIRED",
      message: "Informe o messageId do e-mail.",
    });
  }
  const emailParam = getOptionalString(body, "email");
  const email = await resolverContaGmail(profileToken || "", emailParam);
  const msg = await obterEmail(email, messageId);

  const tiposDisponiveis = await buscarTipos().catch(() => []);

  // A IA e best-effort (retry robusto ja no gerarResumoGemini).
  let resumo: ResumoJson;
  let iaOk = true;
  try {
    ({ resumo } = await gerarResumoGemini({
      text: `Assunto: ${msg.subject}\nRemetente: ${msg.from}\n\n${msg.corpo}`,
      origem: "email",
      model: geminiModel,
      assuntosDisponiveis: tiposDisponiveis.map((t) => ({
        id: t.id,
        nome: t.nome,
      })),
      ramal,
      usuario,
    }));
  } catch (error) {
    iaOk = false;
    console.warn(
      `[gmail:preview] req=${requestId} resumo falhou: ${getErrorMessage(
        error,
      )} — seguindo com campos vazios.`,
    );
    resumo = {
      titulo: "",
      resumo: "",
      pontos_principais: [],
      providencias_sugeridas: [],
      cliente_mencionado: { nome: "", cnpj: "" },
      assunto_sugerido: "",
      assunto_escolhido: { id: "", nome: "" },
    };
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
  else tipo = await resolverAssuntoPorTexto(resumo.assunto_sugerido || resumo.titulo);

  const origem = await resolverOrigem();

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
  const porMencao = await resolverClientePorMencao(resumo.cliente_mencionado);
  const cliente = porMencao
    ? { status: "encontrado" as const, cliente: porMencao, via: "ia_mencao" }
    : { status: "nao_encontrado" as const };
  const clienteEncontrado =
    cliente.status === "encontrado" ? cliente.cliente : undefined;

  const descricao = montarDescricaoEmail({
    razaoSocial: clienteEncontrado?.razao_social,
    cnpj: clienteEncontrado?.cnpj,
    remetente: msg.from,
    assunto: msg.subject,
    dataHora: msg.date,
    atendente: usuario || execNomePerfil || "",
    idEmail: messageId,
    resumo: resumo.resumo,
    pontosPrincipais: resumo.pontos_principais,
    providencias: resumo.providencias_sugeridas,
    corpo: msg.corpo,
  });

  console.log(
    `[gmail:preview] req=${requestId} msg=${messageId} conta=${email} ` +
      `cliente=${clienteEncontrado?.id || cliente.status} tipo=${
        tipo.id || tipo.fonte
      } setor=${setor.id || setor.fonte} executor=${executor.id || executor.fonte}`,
  );

  res.status(200).json({
    ok: true,
    data: {
      requestId,
      fonte: "email",
      messageId,
      dryRun: isDryRun(),
      iaOk,
      email: {
        conta: email,
        de: msg.from,
        assunto: msg.subject,
        data: msg.date,
        snippet: msg.snippet,
      },
      chamada: {
        tipo: "email",
        dataHora: msg.date,
        remetente: msg.from,
        assunto: msg.subject,
        atendente: usuario || execNomePerfil || "",
        idEmail: messageId,
      },
      ia: resumo,
      transcricao: msg.corpo,
      cliente,
      refs: { tipo, origem, setor, executor },
      descricao,
    },
  });
}

// ---------------------------------------------------------------------------
// POST /gmail/chamado/criar — cria o chamado (dry-run + idempotencia por messageId)
// ---------------------------------------------------------------------------

export async function gmailCriarController(req: Request, res: Response) {
  const requestId = randomUUID();
  const body = ensureBodyObject(req.body);
  const messageId = getOptionalString(body, "messageId");

  const setoresRaw = body.setores_vinculados;
  const setores = Array.isArray(setoresRaw)
    ? setoresRaw.map((s) => String(s)).filter(Boolean)
    : [];
  const descricaoRaw = body.descricao;
  const chamadoBody: Partial<ChamadoBody> = {
    cliente_id: campoId(body, "cliente_id"),
    tipo_apontamento_id: campoId(body, "tipo_apontamento_id"),
    descricao: typeof descricaoRaw === "string" ? descricaoRaw : "",
    origem_id: campoId(body, "origem_id"),
    setores_vinculados: setores,
    executor_id: campoId(body, "executor_id"),
  };

  const faltando = validarChamadoBody(chamadoBody);
  const dryRun = isDryRun();
  if (faltando.length && !dryRun) {
    throw new AppError({
      statusCode: 422,
      code: "SUITE_CAMPOS_OBRIGATORIOS",
      message:
        "Faltam dados obrigatorios para abrir o chamado. Corrija/configure antes de enviar.",
      details: { faltando },
    });
  }

  // --- DEV (dry-run): so devolve o JSON que SERIA enviado. ---
  if (dryRun) {
    const resultado = await criarChamado(chamadoBody as ChamadoBody);
    res.status(200).json({
      ok: true,
      data: {
        requestId,
        dryRun: true,
        faltando,
        mensagem: faltando.length
          ? "Simulado — ainda faltam IDs para envio real: " + faltando.join(", ")
          : "Chamado simulado — envio ao Suite desligado (SUITE360_DRY_RUN).",
        body: resultado.body,
      },
    });
    return;
  }

  // --- PRODUCAO: idempotencia por messageId (nao cria duplicado para o mesmo e-mail) ---
  if (messageId) {
    const jaCriado = await getChamadoCriado(messageId, "gmail").catch(() => null);
    if (jaCriado) {
      res.status(200).json({
        ok: true,
        data: {
          requestId,
          dryRun: false,
          jaExistia: true,
          id: jaCriado.id,
          protocolo: jaCriado.protocolo,
          mensagem: `Chamado ja existente para este e-mail: ${jaCriado.protocolo}`,
        },
      });
      return;
    }
    const reservou = await reservarCriacao(messageId, "gmail").catch(() => true);
    if (!reservou) {
      throw new AppError({
        statusCode: 409,
        code: "CHAMADO_EM_CRIACAO",
        message:
          "Este chamado ja esta sendo criado. Aguarde alguns segundos e verifique.",
      });
    }
  }

  let resultado: Awaited<ReturnType<typeof criarChamado>>;
  try {
    resultado = await criarChamado(chamadoBody as ChamadoBody);
  } catch (error) {
    if (messageId) await liberarCriacao(messageId, "gmail").catch(() => undefined);
    throw error;
  }

  const protocolo = resultado.protocolo || "";
  if (messageId) {
    await salvarChamadoCriado(
      messageId,
      { id: resultado.id || "", protocolo },
      "gmail",
    ).catch(() => undefined);
    await liberarCriacao(messageId, "gmail").catch(() => undefined);
  }
  console.log(
    `[gmail:criar] req=${requestId} msg=${messageId || "-"} ` +
      `cliente=${chamadoBody.cliente_id} protocolo=${protocolo}`,
  );
  res.status(201).json({
    ok: true,
    data: {
      requestId,
      dryRun: false,
      id: resultado.id || "",
      protocolo,
      mensagem: `Chamado criado com sucesso: ${protocolo}`,
    },
  });
}
