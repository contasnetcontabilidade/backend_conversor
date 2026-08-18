import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { AppError, getErrorMessage } from "../lib/errors";
import { gerarResumoGemini, type ResumoJson } from "../services/gemini";
import { transcreverAudio } from "../services/transcricao";
import { registrarCustoChamado } from "../services/custoChamados";
import {
  getChamadoCriado,
  getPreviewCache,
  liberarCriacao,
  reservarCriacao,
  salvarChamadoCriado,
  salvarPreviewCache,
} from "../services/store";
import {
  buscarTipos,
  criarChamado,
  isDryRun,
  montarDescricaoGravacao,
  resolverAssuntoPorTexto,
  resolverClientePorMencao,
  resolverOrigem,
  validarChamadoBody,
  type ChamadoBody,
  type RefResolvida,
} from "../services/suite360";
import { getOptionalString } from "../utils/request";

// Aba "Gravar & Resumir": abre chamado a partir de uma GRAVACAO avulsa do
// microfone. Espelha o gmail/chat controller, com duas diferencas de fundo:
//
//  1. Nao existe identificador externo (nao ha ligacao no GoTo, e-mail nem
//     mensagem). O app gera um UUID por gravacao e ele faz o papel do
//     conversationSpaceId: chave do cache, itemId de custo e idempotencia.
//  2. O conteudo chega como ARQUIVO (multipart), nao como texto — por isso a
//     rota do preview passa pelo uploadAudioMiddleware.

const NS = "gravacao"; // namespace de idempotencia

// Le um campo de ID que pode vir como string OU numero.
// Em multipart tudo chega string, mas o "criar" e JSON — mantem os dois casos.
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
  if (Array.isArray(valor)) {
    return valor.map((v) => String(v || "").trim()).filter(Boolean);
  }
  // multipart manda array de 1 item como string solta.
  const s = String(valor || "").trim();
  return s ? [s] : [];
}

// mm:ss a partir dos segundos que o app cronometrou.
function formatarDuracao(seg: number): string {
  if (!Number.isFinite(seg) || seg <= 0) return "-";
  const m = Math.floor(seg / 60);
  const s = Math.round(seg % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function dataHoraLegivel(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

// ---------------------------------------------------------------------------
// POST /gravacao/chamado/preview — multipart (audioFile)
// ---------------------------------------------------------------------------

export async function gravacaoPreviewController(req: Request, res: Response) {
  const requestId = randomUUID();
  // Em multipart os campos vem como string no body do multer.
  const body = (req.body || {}) as Record<string, unknown>;
  const texto = (k: string) => {
    const v = body[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };

  const gravacaoId = texto("gravacaoId");
  if (!gravacaoId) {
    throw new AppError({
      statusCode: 400,
      code: "GRAVACAO_ID_REQUIRED",
      message: "Identificador da gravacao ausente.",
    });
  }

  const geminiModel = texto("geminiModel");
  const ramal = texto("ramal");
  const usuario = texto("usuario");
  const setorIdPerfil = texto("setorId");
  const setorNomePerfil = texto("setorNome");
  const execIdPerfil = texto("executorId");
  const execNomePerfil = texto("executorNome");
  const duracaoSeg = Number(texto("duracaoSeg") || 0);
  const iniciadaEm = texto("iniciadaEm");

  // ---- Transcricao + resumo (com cache, para reabrir o modal nao custar IA) --
  let transcript = "";
  let resumo: ResumoJson;
  let iaOk = true;

  const cache = await getPreviewCache(gravacaoId).catch(() => null);
  if (cache) {
    transcript = cache.transcript;
    resumo = cache.resumo as ResumoJson;
    iaOk = cache.iaOk;
  } else {
    const audioPath = req.file?.path;
    if (!audioPath) {
      throw new AppError({
        statusCode: 400,
        code: "AUDIO_FILE_REQUIRED",
        message: "Envie o arquivo de audio da gravacao.",
      });
    }

    const t = await transcreverAudio({
      audioPath,
      ramal,
      usuario,
      fonte: "gravacao",
      itemId: gravacaoId,
    });
    transcript = t.transcript;

    const tiposDisponiveis = await buscarTipos().catch(() => []);
    try {
      ({ resumo } = await gerarResumoGemini({
        text: transcript,
        // O conteudo E fala transcrita: o prompt de ligacao e o correto aqui.
        // O que muda e so a "fonte", que e rotulo de custo no painel.
        origem: "ligacao",
        model: geminiModel,
        assuntosDisponiveis: tiposDisponiveis.map((x) => ({
          id: x.id,
          nome: x.nome,
        })),
        ramal,
        usuario,
        fonte: "gravacao",
        itemId: gravacaoId,
      }));
    } catch (error) {
      iaOk = false;
      console.warn(
        `[gravacao:preview] req=${requestId} resumo falhou: ${getErrorMessage(
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
    // So cacheia o que presta: resumo vazio nao vale guardar por 48h.
    if (iaOk) {
      await salvarPreviewCache(gravacaoId, {
        transcript,
        resumo,
        iaOk,
        gravacaoNota: "",
      }).catch(() => undefined);
    }
  }

  // ---- Assunto: env > escolha da IA (validada na lista) > match textual ------
  const tiposParaValidar = await buscarTipos().catch(() => []);
  const tipoEnv = (process.env.SUITE360_TIPO_APONTAMENTO_ID || "").trim();
  const escolhaIA = resumo.assunto_escolhido;
  const tipoNaLista = escolhaIA?.id
    ? tiposParaValidar.find((t) => String(t.id) === String(escolhaIA.id))
    : undefined;
  let tipo: RefResolvida;
  if (tipoEnv) tipo = { id: tipoEnv, fonte: "env" };
  else if (tipoNaLista)
    tipo = { id: tipoNaLista.id, nome: tipoNaLista.nome, fonte: "ia" };
  else
    tipo = await resolverAssuntoPorTexto(
      resumo.assunto_sugerido || resumo.titulo,
    );

  // Origem: a mesma da ligacao (decisao de produto — uma gravacao e atendimento
  // de voz, e reusar evita cadastrar origem nova no Suite).
  const origem = await resolverOrigem();

  // Setor/executor: perfil > env > ausente. Sem lookup por nome: nao ha
  // relatorio do GoTo de onde tirar o "NOME - SETOR".
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

  const atendente = usuario || execNomePerfil || ramal || "";
  const dataHora = dataHoraLegivel(iniciadaEm);
  const duracao = formatarDuracao(duracaoSeg);

  const descricao = montarDescricaoGravacao({
    razaoSocial: clienteEncontrado?.razao_social,
    cnpj: clienteEncontrado?.cnpj,
    dataHora,
    duracao,
    atendente,
    idGravacao: gravacaoId,
    resumo: resumo.resumo,
    pontosPrincipais: resumo.pontos_principais,
    providencias: resumo.providencias_sugeridas,
    transcricao: transcript,
  });

  console.log(
    `[gravacao:preview] req=${requestId} id=${gravacaoId} dur=${duracao} ` +
      `cache=${cache ? "sim" : "nao"} cliente=${
        clienteEncontrado?.id || cliente.status
      } tipo=${tipo.id || tipo.fonte} setor=${setor.id || setor.fonte} ` +
      `executor=${executor.id || executor.fonte}`,
  );

  res.status(200).json({
    ok: true,
    data: {
      requestId,
      fonte: "gravacao",
      gravacaoId,
      dryRun: isDryRun(),
      iaOk,
      // Mesmas CHAVES que o modal de revisao ja consome nas outras fontes.
      chamada: {
        tipo: "gravacao",
        dataHora,
        duracao,
        atendente,
        idGravacao: gravacaoId,
      },
      ia: resumo,
      transcricao: transcript,
      cliente,
      refs: { tipo, origem, setor, executor },
      descricao,
    },
  });
}

// ---------------------------------------------------------------------------
// POST /gravacao/chamado/criar
// ---------------------------------------------------------------------------

export async function gravacaoCriarController(req: Request, res: Response) {
  const requestId = randomUUID();
  const body = (req.body || {}) as Record<string, unknown>;
  const gravacaoId = getOptionalString(body, "gravacaoId") || "";

  const setores = listaDeStrings(body.setores_vinculados);
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

  // --- PRODUCAO: idempotencia pelo id da gravacao ---
  if (gravacaoId) {
    const jaCriado = await getChamadoCriado(gravacaoId, NS).catch(() => null);
    if (jaCriado) {
      res.status(200).json({
        ok: true,
        data: {
          requestId,
          dryRun: false,
          jaExistia: true,
          id: jaCriado.id,
          protocolo: jaCriado.protocolo,
          mensagem: `Chamado ja existente para esta gravacao: ${jaCriado.protocolo}`,
        },
      });
      return;
    }
    const reservou = await reservarCriacao(gravacaoId, NS).catch(() => true);
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
    if (gravacaoId) {
      await liberarCriacao(gravacaoId, NS).catch(() => undefined);
    }
    throw error;
  }

  const protocolo = resultado.protocolo || "";
  if (gravacaoId) {
    // Se o registro de idempotencia falhar, NAO liberar a reserva: ela e a
    // unica barreira que resta contra criar o mesmo chamado duas vezes.
    let registrou = true;
    await salvarChamadoCriado(
      gravacaoId,
      { id: resultado.id || "", protocolo },
      NS,
    ).catch((erro) => {
      registrou = false;
      console.error(
        `[gravacao:criar] req=${requestId} id=${gravacaoId} protocolo=${protocolo} ` +
          `NAO registrou a idempotencia: ${getErrorMessage(erro)}`,
      );
    });
    if (registrou) {
      await liberarCriacao(gravacaoId, NS).catch(() => undefined);
    }
    await registrarCustoChamado({
      itemId: gravacaoId,
      fonte: "gravacao",
      clienteId: String(chamadoBody.cliente_id ?? ""),
      cliente: getOptionalString(body, "cliente_nome"),
      assuntoId: String(chamadoBody.tipo_apontamento_id ?? ""),
      assunto: getOptionalString(body, "assunto_nome"),
      ramal: getOptionalString(body, "ramal"),
      usuario: getOptionalString(body, "usuario"),
      protocolo,
    }).catch(() => undefined);
  }

  console.log(
    `[gravacao:criar] req=${requestId} id=${gravacaoId || "-"} ` +
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
