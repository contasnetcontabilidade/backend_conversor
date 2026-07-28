import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { AppError, getErrorMessage } from "../lib/errors";
import { gerarResumoGemini, type ResumoJson } from "../services/gemini";
import { transcreverAudio } from "../services/transcricao";
import { downloadRecording, extractRecordingIds } from "../services/gotoApi";
import {
  analisarChamada,
  getReportComRetry,
  nomeDoRamal,
  type AnaliseChamada,
} from "./goto.controller";
import {
  getChamadoCriado,
  getPreviewCache,
  liberarCriacao,
  liberarPreview,
  marcarChamadoAberto,
  reservarCriacao,
  reservarPreview,
  salvarChamadoCriado,
  salvarPreviewCache,
} from "../services/store";
import { isAblyConfigured, publishChamadoCriado } from "../services/ably";
import { registrarCustoChamado } from "../services/custoChamados";
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
  atendente: string; // primeiro atendente (compat)
  atendentes: string[]; // TODOS os atendentes (com duracao quando houver)
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
  // Lista de TODOS os atendentes (inclui transferidos), com duracao quando houver.
  const atendentes = (analise?.answerers || []).map((a) => {
    const base = [a.ramal, a.nome].filter(Boolean).join(" - ");
    const dur = a.duracaoSeg ? ` (${formatarDuracaoSeg(a.duracaoSeg)})` : "";
    return base + dur;
  });

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

  return {
    dataHora,
    duracao,
    telefoneOrigem,
    telefoneDestino,
    atendente,
    atendentes,
    direction,
  };
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
  // Setor/executor do PERFIL (conta ativa no desktop). Quando vem, tem PRIORIDADE
  // sobre o env e sobre o match por nome do GoTo — assim o chamado usa o executor
  // que a pessoa configurou no perfil (mesmo comportamento do fluxo de e-mail).
  const setorIdPerfil = getOptionalString(body, "setorId");
  const setorNomePerfil = getOptionalString(body, "setorNome");
  const execIdPerfil = getOptionalString(body, "executorId");
  const execNomePerfil = getOptionalString(body, "executorNome");

  // Ja existe chamado para esta ligacao? -> em tratamento (nao roda a IA de novo).
  const jaCriadoPrev = await getChamadoCriado(conversationSpaceId).catch(
    () => null,
  );
  if (jaCriadoPrev) {
    res.status(200).json({
      ok: true,
      data: {
        conversationSpaceId,
        emTratamento: true,
        jaCriado: true,
        mensagem: "Chamado ja gerado para esta ligacao.",
      },
    });
    return;
  }
  // OUTRO atendente ja esta processando ESTA ligacao agora? -> em tratamento
  // (evita a IA rodar 2x). Escopado pelo ramal de quem clicou: o mesmo atendente
  // pode cancelar e reabrir sem travar. Liberado no finally.
  const podePreview = await reservarPreview(
    conversationSpaceId,
    "goto",
    ramalClicou || "",
  ).catch(() => true);
  if (!podePreview) {
    res.status(200).json({
      ok: true,
      data: {
        conversationSpaceId,
        emTratamento: true,
        mensagem: "Este chamado ja esta sendo tratado por outro atendente.",
      },
    });
    return;
  }

  try {
    await marcarChamadoAberto(conversationSpaceId).catch(() => undefined);

    const report = await getReportComRetry(conversationSpaceId);
  if (!report) {
    throw new AppError({
      statusCode: 409,
      code: "REPORT_NOT_READY",
      message: "Relatorio da chamada ainda nao esta pronto. Tente em instantes.",
    });
  }

  const recordingIds = extractRecordingIds(report);
  if (!recordingIds.length) {
    throw new AppError({
      statusCode: 404,
      code: "RECORDING_NOT_FOUND",
      message:
        "Gravacao ainda nao disponivel para esta chamada. Tente novamente em instantes.",
    });
  }

  const analise = analisarChamada(report);
  const meta = extrairMetaChamada(report, analise, endedAt);

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

  // Nomes dos funcionarios que participam DESTA ligacao (caller + answerers do
  // relatorio), sem o sufixo " - SETOR". Viram dica de grafia na transcricao —
  // apenas de quem esta na ligacao, nunca uma lista global.
  const nomesConhecidos = Array.from(
    new Set(
      [analise?.caller, ...(analise?.answerers || [])]
        .map((p) => {
          const nome = p?.nome || "";
          const i = nome.lastIndexOf(" - ");
          return (i >= 0 ? nome.slice(0, i) : nome).trim();
        })
        .filter((n) => n.length >= 2),
    ),
  );

  // Lista de assuntos do Suite para a IA escolher UM (com base no que foi dito) e
  // para validar o assunto vindo do cache. Best-effort: se falhar, segue sem lista.
  const tiposDisponiveis = await buscarTipos().catch(() => []);

  // Cache do preview: se esta ligacao JA foi processada (transcrita + resumida) e
  // o chamado ainda nao foi criado, reaproveita o resultado — sem re-baixar a
  // gravacao, re-transcrever nem re-resumir. `forcarReprocesso` no corpo ignora
  // o cache (escotilha de seguranca; o app normal nao envia).
  const forcarReprocesso = body?.forcarReprocesso === true;
  const cache = forcarReprocesso
    ? null
    : await getPreviewCache(conversationSpaceId).catch(() => null);

  let transcript: string;
  let gravacaoNota: string;
  let resumo: ResumoJson;
  let iaOk = true;

  if (cache) {
    transcript = cache.transcript;
    gravacaoNota = cache.gravacaoNota;
    resumo = cache.resumo as ResumoJson;
    iaOk = cache.iaOk;
    console.log(
      `[suite360:preview] req=${requestId} conv=${conversationSpaceId} ` +
        "cache HIT — reaproveitando transcricao/resumo (sem reprocessar).",
    );
  } else {
    // Transcreve TODOS os trechos de gravacao (transferencia = varios trechos) e
    // concatena na ordem. Trecho silencioso (AUDIO_SEM_FALA) e pulado; se TODOS
    // vierem vazios, propaga o erro. RECORDING_NOT_READY sobe para o retry do app.
    transcript = "";
    for (let i = 0; i < recordingIds.length; i += 1) {
      const audioPath = await downloadRecording(recordingIds[i]);
      let parte = "";
      try {
        const t = await transcreverAudio({
          audioPath,
          ramal: ramalUsuario,
          usuario: nomeUsuario,
          nomesConhecidos,
          fonte: "ligacao",
          itemId: conversationSpaceId,
        });
        parte = String(t.transcript || "").trim();
      } catch (error) {
        const code = error instanceof AppError ? error.code : "";
        if (code === "AUDIO_SEM_FALA") continue; // trecho mudo: ignora
        throw error;
      }
      if (!parte) continue;
      if (transcript) transcript += "\n\n";
      if (recordingIds.length > 1) {
        transcript += `--- Trecho ${i + 1}/${recordingIds.length} ---\n`;
      }
      transcript += parte;
    }
    if (!transcript.trim()) {
      throw new AppError({
        statusCode: 422,
        code: "AUDIO_SEM_FALA",
        message: "Nenhuma fala foi detectada no audio.",
      });
    }
    gravacaoNota = `Gravacao disponivel no GoTo (${recordingIds.length} trecho${
      recordingIds.length > 1 ? "s" : ""
    }: ${recordingIds.join(", ")}).`;

    // A IA e best-effort: se falhar (raro, com o retry), NAO cancela o fluxo.
    // Segue para a revisao com os campos da IA vazios (o usuario preenche a mao).
    try {
      ({ resumo } = await gerarResumoGemini({
        text: transcript,
        model: geminiModel,
        assuntosDisponiveis: tiposDisponiveis.map((t) => ({
          id: t.id,
          nome: t.nome,
        })),
        ramal: ramalUsuario,
        usuario: nomeUsuario,
        fonte: "ligacao",
        itemId: conversationSpaceId,
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

    // So guarda no cache quando deu tudo certo (transcricao + resumo). Se a IA
    // falhou, NAO cacheia — assim reabrir tenta de novo em vez de fixar o vazio.
    if (iaOk) {
      await salvarPreviewCache(conversationSpaceId, {
        transcript,
        resumo,
        iaOk,
        gravacaoNota,
      }).catch(() => undefined);
    }
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
      const porMencao = await resolverClientePorMencao(
        resumo.cliente_mencionado,
        resumo.cliente_alternativas,
      );
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

  // Setor/executor: PERFIL (o que a pessoa configurou) > env > match por nome do
  // GoTo. So faz o lookup por nome quando nao veio nem perfil nem env.
  const precisaSetorLookup = !setorIdPerfil && !setorEnv;
  const precisaExecLookup = !execIdPerfil && !execEnv;
  const [origem, setorLk, execLk] = await Promise.all([
    resolverOrigem(),
    precisaSetorLookup
      ? resolverSetorPorNomeUsuario(nomeUsuario)
      : Promise.resolve(null),
    precisaExecLookup
      ? resolverExecutorPorNome(nomeUsuario)
      : Promise.resolve(null),
  ]);
  const setor: RefResolvida = setorIdPerfil
    ? { id: setorIdPerfil, nome: setorNomePerfil || undefined, fonte: "perfil" }
    : setorEnv
      ? { id: setorEnv, fonte: "env" }
      : (setorLk as RefResolvida);
  const executor: RefResolvida = execIdPerfil
    ? { id: execIdPerfil, nome: execNomePerfil || undefined, fonte: "perfil" }
    : execEnv
      ? { id: execEnv, fonte: "env" }
      : (execLk as RefResolvida);

  const clienteEncontrado =
    cliente.status === "encontrado" ? cliente.cliente : undefined;

  const descricao = montarDescricao({
    razaoSocial: clienteEncontrado?.razao_social,
    cnpj: clienteEncontrado?.cnpj,
    dataHora: meta.dataHora,
    tipo: analise?.tipo || "",
    numeroExterno,
    telefoneOrigem: meta.telefoneOrigem,
    telefoneDestino: meta.telefoneDestino,
    duracao: meta.duracao,
    atendente: meta.atendente,
    atendentes: meta.atendentes,
    idChamadaGoto: conversationSpaceId,
    resumo: resumo.resumo,
    pontosPrincipais: resumo.pontos_principais,
    providencias: resumo.providencias_sugeridas,
    transcricao: transcript,
    gravacao: gravacaoNota,
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
        atendentes: meta.atendentes,
        idGoto: conversationSpaceId,
        recordingIds,
      },
      ia: resumo,
      transcricao: transcript,
      gravacao: gravacaoNota,
      cliente,
      refs: { tipo, origem, setor, executor },
      descricao,
    },
  });
  } finally {
    // Libera o lock ao FIM do preview (sucesso ou erro). O lock so existe
    // enquanto a IA roda (evita 2 atendentes processando ao mesmo tempo). Se o
    // usuario cancelar e clicar de novo, NAO fica preso em "em tratamento". A
    // duplicacao do chamado em si e barrada por getChamadoCriado (nao pelo lock).
    await liberarPreview(conversationSpaceId).catch(() => undefined);
  }
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

// Avisa TODOS os atendentes da ligacao (inclui transferidos) que o chamado foi
// criado, para o botao "abrir chamado" desabilitar em todas as maquinas.
// Best-effort: nunca quebra a criacao se o push falhar.
async function broadcastChamadoCriado(
  conversationSpaceId: string,
): Promise<void> {
  if (!isAblyConfigured()) return;
  try {
    const report = await getReportComRetry(conversationSpaceId);
    if (!report) return;
    const analise = analisarChamada(report);
    const ramais = new Set<string>();
    if (analise?.caller?.ramal) ramais.add(analise.caller.ramal);
    for (const a of analise?.answerers || []) {
      if (a.ramal) ramais.add(a.ramal);
    }
    await Promise.all(
      [...ramais].map((r) =>
        publishChamadoCriado(r, { conversationSpaceId }).catch(() => undefined),
      ),
    );
  } catch {
    /* best-effort */
  }
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

  // dry-run com campos faltando: nao e uma criacao valida — so mostra o que falta,
  // sem travar nem avisar os outros (o usuario ainda vai corrigir e reenviar).
  if (dryRun && faltando.length) {
    const resultado = await criarChamado(chamadoBody as ChamadoBody);
    console.log(
      `[suite360:criar] req=${requestId} conv=${conversationSpaceId || "-"} ` +
        `DRY-RUN incompleto faltando=[${faltando.join(",")}]`,
    );
    res.status(200).json({
      ok: true,
      data: {
        requestId,
        dryRun: true,
        faltando,
        mensagem:
          "Simulado — ainda faltam IDs para envio real: " + faltando.join(", "),
        body: resultado.body,
      },
    });
    return;
  }

  // Criacao "valida" (producao OU simulacao completa): idempotencia + aviso a
  // TODOS os atendentes valem INCLUSIVE no dry-run (ninguem gera dois chamados).
  if (conversationSpaceId) {
    const jaCriado = await getChamadoCriado(conversationSpaceId).catch(
      () => null,
    );
    if (jaCriado) {
      await broadcastChamadoCriado(conversationSpaceId);
      console.log(
        `[suite360:criar] req=${requestId} conv=${conversationSpaceId} JA EXISTIA protocolo=${jaCriado.protocolo || "-"}`,
      );
      res.status(200).json({
        ok: true,
        data: {
          requestId,
          dryRun,
          jaExistia: true,
          id: jaCriado.id,
          protocolo: jaCriado.protocolo,
          mensagem: `Chamado ja gerado para esta ligacao${
            jaCriado.protocolo ? ": " + jaCriado.protocolo : ""
          }.`,
        },
      });
      return;
    }
    // Lock atomico: evita que dois atendentes criem 2 ao mesmo tempo.
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
    await salvarChamadoCriado(
      conversationSpaceId,
      { id: resultado.id || "", protocolo },
      "goto",
      dryRun ? 600 : 30 * 24 * 3600, // dry-run: 10 min (permite re-testar a mesma ligacao)
    ).catch(() => undefined);
    await liberarCriacao(conversationSpaceId).catch(() => undefined);
    await broadcastChamadoCriado(conversationSpaceId);
  }

  // Custo de IA deste atendimento -> cliente/assunto (painel). So em criacao
  // real: em dry-run nao existe chamado de verdade para atribuir custo.
  if (!dryRun && conversationSpaceId) {
    await registrarCustoChamado({
      itemId: conversationSpaceId,
      fonte: "ligacao",
      clienteId: String(chamadoBody.cliente_id ?? ""),
      cliente: getOptionalString(body, "cliente_nome"),
      assuntoId: String(chamadoBody.tipo_apontamento_id ?? ""),
      assunto: getOptionalString(body, "assunto_nome"),
      ramal: getOptionalString(body, "ramal"),
      usuario: getOptionalString(body, "usuario"),
      protocolo,
    }).catch(() => undefined);
  }

  if (dryRun) {
    console.log(
      `[suite360:criar] req=${requestId} conv=${conversationSpaceId || "-"} ` +
        `cliente=${chamadoBody.cliente_id || "-"} DRY-RUN (nao enviado)`,
    );
    res.status(200).json({
      ok: true,
      data: {
        requestId,
        dryRun: true,
        faltando,
        mensagem:
          "Chamado simulado — envio ao Suite desligado (SUITE360_DRY_RUN).",
        body: resultado.body,
      },
    });
    return;
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
