import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { AppError, getErrorMessage, isRecord } from "../lib/errors";
import { gerarResumoGemini, type ResumoJson } from "../services/gemini";
import { transcreverAudio } from "../services/transcricao";
import {
  downloadRecording,
  extractRecordingId,
  getContatoGotoDiag,
} from "../services/gotoApi";
import {
  analisarChamada,
  getReportComRetry,
  nomeDoRamal,
  type AnaliseChamada,
} from "./goto.controller";
import {
  getChamadoCriado,
  liberarCriacao,
  marcarChamadoAberto,
  reservarCriacao,
  salvarChamadoCriado,
} from "../services/store";
import {
  buscarClientes,
  buscarOrigens,
  buscarSetores,
  buscarTipos,
  buscarUsuarios,
  criarChamado,
  isDryRun,
  montarDescricao,
  resolverAssuntoPorTexto,
  resolverClienteInterno,
  resolverClientePorMencao,
  resolverClientePorTelefone,
  resolverExecutorPorNome,
  resolverOrigem,
  resolverSetorPorNomeUsuario,
  validarChamadoBody,
  type ChamadoBody,
  type RefResolvida,
  type ResolucaoCliente,
} from "../services/suite360";
import { ensureBodyObject, getOptionalString } from "../utils/request";

// ---------------------------------------------------------------------------
// Extracao de metadados da chamada a partir do relatorio (defensiva).
// ---------------------------------------------------------------------------

function formatarDataHora(valor: unknown): string {
  if (typeof valor !== "string" && typeof valor !== "number") return "";
  const d = new Date(valor as string | number);
  if (Number.isNaN(d.getTime())) return typeof valor === "string" ? valor : "";
  try {
    return d.toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "America/Sao_Paulo",
    });
  } catch {
    return d.toISOString();
  }
}

function formatarDuracaoSeg(seg: number): string {
  if (!Number.isFinite(seg) || seg <= 0) return "";
  const s = Math.round(seg);
  const min = Math.floor(s / 60);
  const rest = s % 60;
  return `${min}m ${String(rest).padStart(2, "0")}s`;
}

function primeiroNumero(obj: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return NaN;
}

function primeiraString(
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

interface MetaChamada {
  dataHora: string;
  duracao: string;
  telefoneOrigem: string;
  telefoneDestino: string;
  atendente: string;
  direction: string;
}

function extrairMetaChamada(
  report: Record<string, unknown>,
  analise: AnaliseChamada | null,
  fallbackEndedAt?: string,
): MetaChamada {
  const direction = String(report.direction || "").toUpperCase();

  // Data/hora: o relatorio do GoTo usa "callCreated"/"callEnded" (ISO).
  const inicioRaw =
    primeiraString(report, [
      "callCreated",
      "startTime",
      "start",
      "startedAt",
      "createdAt",
      "date",
      "timestamp",
    ]) || fallbackEndedAt;
  const dataHora = formatarDataHora(inicioRaw);

  // Duracao: campo direto (segundos) ou diferenca callCreated/callEnded.
  let duracaoSeg = primeiroNumero(report, [
    "duration",
    "durationSeconds",
    "duracao",
  ]);
  if (!Number.isFinite(duracaoSeg)) {
    const ini = Date.parse(
      String(report.callCreated || report.startTime || report.start || ""),
    );
    const fim = Date.parse(
      String(
        report.callEnded || report.endTime || report.end || fallbackEndedAt || "",
      ),
    );
    if (Number.isFinite(ini) && Number.isFinite(fim) && fim > ini) {
      duracaoSeg = (fim - ini) / 1000;
    }
  }
  const duracao = formatarDuracaoSeg(duracaoSeg);

  const numeroExterno = analise?.numeroExterno || "";
  const atendenteObj = analise?.answerers?.[0] || analise?.caller;
  const atendente = atendenteObj
    ? [atendenteObj.ramal, atendenteObj.nome].filter(Boolean).join(" - ")
    : "";

  let telefoneOrigem = "";
  let telefoneDestino = "";
  if (analise?.tipo === "interno") {
    telefoneOrigem = analise.caller?.ramal || "";
    telefoneDestino = analise.answerers?.[0]?.ramal || "";
  } else if (direction === "OUTBOUND") {
    telefoneOrigem = atendenteObj?.ramal || "";
    telefoneDestino = numeroExterno;
  } else {
    // INBOUND (default)
    telefoneOrigem = numeroExterno;
    telefoneDestino = atendenteObj?.ramal || "";
  }

  return { dataHora, duracao, telefoneOrigem, telefoneDestino, atendente, direction };
}

// ---------------------------------------------------------------------------
// POST /goto/chamado/preview — monta o rascunho do chamado para REVISAO.
// Nao cria nada no Suite.
// ---------------------------------------------------------------------------

export async function suitePreviewController(req: Request, res: Response) {
  const requestId = randomUUID();
  const body = ensureBodyObject(req.body);
  const conversationSpaceId = getOptionalString(body, "conversationSpaceId");
  if (!conversationSpaceId) {
    throw new AppError({
      statusCode: 400,
      code: "CONVERSATION_ID_REQUIRED",
      message: "Informe conversationSpaceId no corpo da requisicao.",
    });
  }
  const geminiModel = getOptionalString(body, "geminiModel");
  const endedAt = getOptionalString(body, "endedAt");
  // Ramal de QUEM CLICOU em "abrir chamado" (mandado pelo desktop). O chamado
  // (setor/executor/custo) e atribuido a essa pessoa.
  const ramalClicou = getOptionalString(body, "ramal");

  await marcarChamadoAberto(conversationSpaceId).catch(() => undefined);

  const report = await getReportComRetry(conversationSpaceId);
  if (!report) {
    throw new AppError({
      statusCode: 409,
      code: "REPORT_NOT_READY",
      message: "Relatorio da chamada ainda nao esta pronto. Tente em instantes.",
    });
  }

  const recordingId = extractRecordingId(report);
  if (!recordingId) {
    throw new AppError({
      statusCode: 404,
      code: "RECORDING_NOT_FOUND",
      message:
        "Gravacao ainda nao disponivel para esta chamada. Tente novamente em instantes.",
    });
  }

  const analise = analisarChamada(report);
  const meta = extrairMetaChamada(report, analise, endedAt);

  // [DIAGNOSTICO TEMPORARIO] — em ligacao externa, loga os campos que a GoTo
  // manda do contato (para decidir de onde ler empresa/CNPJ). REMOVER depois.
  if (analise?.tipo === "externo") {
    try {
      const parts = Array.isArray(report.participants)
        ? report.participants
        : [];
      const externos = parts.filter(
        (p) => isRecord(p) && isRecord(p.type) && p.type.value === "PHONE_NUMBER",
      );
      console.log(
        `[diag:contato-externo] req=${requestId} phoneParticipants=` +
          JSON.stringify(externos),
      );
      // O relatorio so traz o ID do contato (empresa/CNPJ ficam na agenda).
      // Pega esse id e consulta o cartao completo na Contacts API.
      let contactId = "";
      for (const p of externos) {
        const contato =
          isRecord(p) && isRecord(p.type) && isRecord(p.type.contact)
            ? p.type.contact
            : null;
        const id =
          contato && typeof contato.id === "string" ? contato.id : "";
        if (id) {
          contactId = id;
          break;
        }
      }
      console.log(
        `[diag:contato-externo] req=${requestId} contactId=${contactId || "-"}`,
      );
      if (contactId) {
        const card = await getContatoGotoDiag(contactId);
        console.log(
          `[diag:contato-externo] req=${requestId} contatoCard status=${card.status} body=` +
            JSON.stringify(card.body),
        );
      }
    } catch (e) {
      console.warn(`[diag:contato-externo] req=${requestId} falhou:`, getErrorMessage(e));
    }
  }

  // Usuario do escritorio (fonte de setor, executor E atribuicao de custo da IA).
  // Prioridade: QUEM CLICOU em abrir o chamado (o desktop manda o proprio ramal;
  // pegamos o nome dele no relatorio). Fallback (clicador nao veio ou nao estava
  // na ligacao): interna -> quem LIGOU (caller); externa -> quem ATENDEU (answerer).
  // O nome do GoTo vem como "NOME - SETOR", entao o setor sai do proprio nome.
  let ramalUsuario = "";
  let nomeUsuario = "";
  const nomeClicou = ramalClicou ? nomeDoRamal(report, ramalClicou) : null;
  if (ramalClicou && nomeClicou !== null) {
    ramalUsuario = ramalClicou;
    nomeUsuario = nomeClicou;
  } else {
    const usuarioEscritorio =
      analise?.tipo === "interno" ? analise?.caller : analise?.answerers?.[0];
    nomeUsuario = usuarioEscritorio?.nome || "";
    ramalUsuario = usuarioEscritorio?.ramal || "";
  }

  const audioPath = await downloadRecording(recordingId);
  const transcricao = await transcreverAudio({
    audioPath,
    ramal: ramalUsuario,
    usuario: nomeUsuario,
  });

  // Lista de assuntos do Suite para a IA escolher UM (com base no que foi dito).
  // Best-effort: se a busca falhar, a IA segue sem lista e caimos no match textual.
  const tiposDisponiveis = await buscarTipos().catch(() => []);

  // A IA e best-effort: se falhar (raro, com o retry), NAO cancela o fluxo.
  // Segue para a revisao com os campos da IA vazios (o usuario preenche a mao).
  let resumo: ResumoJson;
  let iaOk = true;
  try {
    ({ resumo } = await gerarResumoGemini({
      srtPath: transcricao.srtPath,
      model: geminiModel,
      assuntosDisponiveis: tiposDisponiveis.map((t) => ({
        id: t.id,
        nome: t.nome,
      })),
      ramal: ramalUsuario,
      usuario: nomeUsuario,
    }));
  } catch (error) {
    iaOk = false;
    console.warn(
      `[suite360:preview] req=${requestId} resumo da IA falhou: ${getErrorMessage(
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

  // ----- Cliente -----
  //  - INTERNA -> cliente padrao do escritorio (CONTAS Servicos Contabeis);
  //  - EXTERNA -> pelo telefone (agenda WhatsApp); se nao achar, tenta pelo
  //    nome/CNPJ que a IA captou na conversa.
  const numeroExterno = analise?.numeroExterno || "";
  let cliente: ResolucaoCliente;
  if (analise?.tipo === "interno") {
    cliente = {
      status: "encontrado",
      cliente: await resolverClienteInterno(),
      via: "padrao_interno",
    };
  } else if (numeroExterno) {
    cliente = await resolverClientePorTelefone(numeroExterno);
    if (cliente.status !== "encontrado") {
      const porMencao = await resolverClientePorMencao(resumo.cliente_mencionado);
      if (porMencao) {
        cliente = { status: "encontrado", cliente: porMencao, via: "ia_mencao" };
      }
    }
  } else {
    cliente = { status: "nao_encontrado" };
  }

  // ----- Assunto (tipo de apontamento) -----
  // Prioridade: env fixo > escolha da IA (validada na lista) > match textual.
  const tipoEnv = (process.env.SUITE360_TIPO_APONTAMENTO_ID || "").trim();
  const setorEnv = (process.env.SUITE360_SETOR_ID || "").trim();
  const execEnv = (process.env.SUITE360_EXECUTOR_ID || "").trim();

  const escolhaIA = resumo.assunto_escolhido;
  const tipoNaLista = escolhaIA?.id
    ? tiposDisponiveis.find((t) => String(t.id) === String(escolhaIA.id))
    : undefined;

  let tipo: RefResolvida;
  if (tipoEnv) {
    tipo = { id: tipoEnv, fonte: "env" };
  } else if (tipoNaLista) {
    tipo = { id: tipoNaLista.id, nome: tipoNaLista.nome, fonte: "ia" };
  } else {
    tipo = await resolverAssuntoPorTexto(
      resumo.assunto_sugerido || resumo.titulo,
    );
  }

  const [origem, setor, executor] = await Promise.all([
    resolverOrigem(),
    setorEnv
      ? Promise.resolve({ id: setorEnv, fonte: "env" as const })
      : resolverSetorPorNomeUsuario(nomeUsuario),
    execEnv
      ? Promise.resolve({ id: execEnv, fonte: "env" as const })
      : resolverExecutorPorNome(nomeUsuario),
  ]);

  const clienteEncontrado =
    cliente.status === "encontrado" ? cliente.cliente : undefined;

  const descricao = montarDescricao({
    razaoSocial: clienteEncontrado?.razao_social,
    cnpj: clienteEncontrado?.cnpj,
    dataHora: meta.dataHora,
    telefoneOrigem: meta.telefoneOrigem,
    telefoneDestino: meta.telefoneDestino,
    duracao: meta.duracao,
    atendente: meta.atendente,
    idChamadaGoto: conversationSpaceId,
    resumo: resumo.resumo,
    pontosPrincipais: resumo.pontos_principais,
    providencias: resumo.providencias_sugeridas,
    transcricao: transcricao.transcript,
    gravacao: `Gravacao disponivel no GoTo (recording id ${recordingId}).`,
  });

  // Log tecnico: nunca inclui a transcricao completa.
  console.log(
    `[suite360:preview] req=${requestId} conv=${conversationSpaceId} ` +
      `tel=${numeroExterno || "-"} cliente=${
        clienteEncontrado?.id || cliente.status
      } tipo=${tipo.id || tipo.fonte} origem=${origem.id || origem.fonte} ` +
      `setor=${setor.id || setor.fonte} executor=${executor.id || executor.fonte}`,
  );

  res.status(200).json({
    ok: true,
    data: {
      requestId,
      conversationSpaceId,
      dryRun: isDryRun(),
      iaOk,
      chamada: {
        tipo: analise?.tipo || "",
        direction: meta.direction,
        numeroExterno,
        dataHora: meta.dataHora,
        duracao: meta.duracao,
        telefoneOrigem: meta.telefoneOrigem,
        telefoneDestino: meta.telefoneDestino,
        atendente: meta.atendente,
        idGoto: conversationSpaceId,
        recordingId,
      },
      ia: resumo,
      transcricao: transcricao.transcript,
      gravacao: `Gravacao disponivel no GoTo (recording id ${recordingId}).`,
      cliente,
      refs: { tipo, origem, setor, executor },
      descricao,
    },
  });
}

// ---------------------------------------------------------------------------
// POST /goto/chamado/criar — cria o chamado (gated por dry-run).
// Recebe o body ja confirmado/editado pelo usuario na tela de revisao.
// ---------------------------------------------------------------------------

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

export async function suiteCriarController(req: Request, res: Response) {
  const requestId = randomUUID();
  const body = ensureBodyObject(req.body);
  const conversationSpaceId = getOptionalString(body, "conversationSpaceId");

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

  // Em producao, faltar ID obrigatorio bloqueia o POST (422). Em dev (dry-run)
  // seguimos para exibir o JSON que SERIA enviado, apenas sinalizando o que falta.
  if (faltando.length && !dryRun) {
    throw new AppError({
      statusCode: 422,
      code: "SUITE_CAMPOS_OBRIGATORIOS",
      message:
        "Faltam dados obrigatorios para abrir o chamado. Corrija/configure antes de enviar.",
      details: { faltando },
    });
  }

  if (conversationSpaceId) {
    await marcarChamadoAberto(conversationSpaceId).catch(() => undefined);
  }

  // --- DEV (dry-run): so devolve o JSON que SERIA enviado, sem criar nada. ---
  if (dryRun) {
    const resultado = await criarChamado(chamadoBody as ChamadoBody);
    console.log(
      `[suite360:criar] req=${requestId} conv=${conversationSpaceId || "-"} ` +
        `cliente=${chamadoBody.cliente_id || "-"} DRY-RUN (nao enviado)` +
        (faltando.length ? ` faltando=[${faltando.join(",")}]` : ""),
    );
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

  // --- PRODUCAO: idempotencia (nao cria chamado duplicado para a mesma ligacao) ---
  if (conversationSpaceId) {
    const jaCriado = await getChamadoCriado(conversationSpaceId).catch(
      () => null,
    );
    if (jaCriado) {
      console.log(
        `[suite360:criar] req=${requestId} conv=${conversationSpaceId} JA EXISTIA protocolo=${jaCriado.protocolo}`,
      );
      res.status(200).json({
        ok: true,
        data: {
          requestId,
          dryRun: false,
          jaExistia: true,
          id: jaCriado.id,
          protocolo: jaCriado.protocolo,
          mensagem: `Chamado ja existente para esta ligacao: ${jaCriado.protocolo}`,
        },
      });
      return;
    }
    // Lock atomico: evita que caller+atendente (interna) criem 2 ao mesmo tempo.
    const reservou = await reservarCriacao(conversationSpaceId).catch(() => true);
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
    if (conversationSpaceId) {
      await liberarCriacao(conversationSpaceId).catch(() => undefined);
    }
    throw error;
  }

  const protocolo = resultado.protocolo || "";
  if (conversationSpaceId) {
    await salvarChamadoCriado(conversationSpaceId, {
      id: resultado.id || "",
      protocolo,
    }).catch(() => undefined);
    await liberarCriacao(conversationSpaceId).catch(() => undefined);
  }
  console.log(
    `[suite360:criar] req=${requestId} conv=${conversationSpaceId || "-"} ` +
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

// ---------------------------------------------------------------------------
// GET /suite360/clientes?q=  (ou ?cnpj=) — busca manual de cliente no modal.
// Proxy que mantem a chave da API no backend.
// ---------------------------------------------------------------------------

export async function suiteClientesController(req: Request, res: Response) {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const cnpj = typeof req.query.cnpj === "string" ? req.query.cnpj.trim() : "";
  if (!q && !cnpj) {
    throw new AppError({
      statusCode: 400,
      code: "BUSCA_VAZIA",
      message: "Informe q (nome) ou cnpj para buscar o cliente.",
    });
  }

  try {
    const clientes = await buscarClientes({ q, cnpj });
    res.status(200).json({ ok: true, data: { clientes } });
  } catch (error) {
    // Repassa erro amigavel (401/etc) sem vazar detalhes sensiveis.
    if (error instanceof AppError) throw error;
    throw new AppError({
      statusCode: 502,
      code: "SUITE_BUSCA_FALHOU",
      message: "Falha ao buscar clientes no Suite360.",
      details: { cause: getErrorMessage(error) },
    });
  }
}

// ---------------------------------------------------------------------------
// Proxies das listas dos dropdowns do modal (chave fica no backend).
// GET /suite360/tipos?q=  /setores  /origens  /usuarios?q=
// ---------------------------------------------------------------------------

function queryQ(req: Request): string {
  return typeof req.query.q === "string" ? req.query.q.trim() : "";
}

export async function suiteTiposController(req: Request, res: Response) {
  const itens = await buscarTipos(queryQ(req));
  res.status(200).json({ ok: true, data: { itens } });
}

export async function suiteSetoresController(_req: Request, res: Response) {
  const itens = await buscarSetores();
  res.status(200).json({ ok: true, data: { itens } });
}

export async function suiteOrigensController(_req: Request, res: Response) {
  const itens = await buscarOrigens();
  res.status(200).json({ ok: true, data: { itens } });
}

export async function suiteUsuariosController(req: Request, res: Response) {
  const itens = await buscarUsuarios(queryQ(req));
  res.status(200).json({ ok: true, data: { itens } });
}
