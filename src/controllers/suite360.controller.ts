import { randomUUID } from "crypto";
import fs from "fs";
import { Request, Response } from "express";
import { AppError, getErrorMessage } from "../lib/errors";
import {
  gerarResumoGemini,
  resumoVazio,
  PROMPT_VERSION,
  type ResumoJson,
} from "../services/gemini";
import { transcreverAudio } from "../services/transcricao";
import {
  descreverTrechos,
  downloadRecording,
  escolherTrechoPeloRelatorio,
  extractRecordings,
  type TrechoGravacao,
} from "../services/gotoApi";
import {
  analisarChamada,
  getReportComRetry,
  nomeDoRamal,
  type AnaliseChamada,
} from "./goto.controller";
import {
  getChamadoCriado,
  getPreviewCache,
  liberarPreview,
  marcarChamadoAberto,
  reservarPreview,
  salvarPreviewCache,
  salvarTrechoPrincipal,
} from "../services/store";
import { isAblyConfigured, publishChamadoCriado } from "../services/ably";
import { fluxoCriarChamado } from "../services/chamadoFluxo";
import { montarRefs } from "../services/chamadoRefs";
import {
  buscarCamposDoTipo,
  buscarClientes,
  buscarOrigens,
  buscarProcessos,
  buscarSetores,
  buscarTipos,
  buscarUsuarios,
  criarChamado,
  isDryRun,
  montarDescricao,
  previewExecutor,
  resolverAssuntoPorTexto,
  resolverClienteInterno,
  resolverClientePorMencao,
  resolverClientePorTelefone,
  resolverExecutorPorNome,
  resolverOrigem,
  resolverSetorPorNomeUsuario,
  type RefResolvida,
  type ResolucaoCliente,
} from "../services/suite360";
import { ensureBodyObject, getOptionalString } from "../utils/request";

// ---------------------------------------------------------------------------
// Escolha do trecho principal da gravacao.
//
// Uma ligacao transferida chega como VARIOS trechos ("legs"), um por atendente.
// So o principal e transcrito: e onde o assunto foi tratado, e pagar IA pelas
// pernas curtas ("vou te passar pro fiscal") piorava o resumo alem de custar.
// ---------------------------------------------------------------------------

// Muda quando a regra de "quais trechos entram na transcricao" muda. Serve para
// invalidar o cache de 48h: sem isso, ligacoes ja processadas continuariam
// devolvendo o texto antigo, concatenado, e pareceria que nada mudou.
export const TRECHO_ESTRATEGIA_VERSAO = "principal-v1";

interface EscolhaComArquivos {
  indice: number;
  criterio: string;
  /** Downloads ja feitos durante a medicao, por indice — evita baixar de novo. */
  arquivos?: Record<number, string>;
}

async function tamanhoDoArquivo(caminho: string): Promise<number> {
  try {
    const st = await fs.promises.stat(caminho);
    return st.size;
  } catch {
    return 0;
  }
}

function apagarTmp(caminho: string) {
  fs.promises.unlink(caminho).catch(() => undefined);
}

// Decide qual trecho transcrever. Tenta primeiro o que o relatorio ja diz
// (de graca); so quando ele nao decide e que baixa os audios para medir.
async function escolherTrechoPrincipal(
  trechos: TrechoGravacao[],
  requestId: string,
): Promise<EscolhaComArquivos> {
  const peloRelatorio = escolherTrechoPeloRelatorio(trechos);
  if (peloRelatorio) return peloRelatorio;

  // O relatorio nao informou duracao (ou empatou). Baixar e barato — o caro e a
  // IA — entao medimos o tamanho do arquivo, que para MP3 de bitrate constante
  // e proporcional a duracao.
  const arquivos: Record<number, string> = {};
  let melhor = 0;
  let melhorTamanho = -1;
  for (const t of trechos) {
    let caminho: string;
    try {
      caminho = await downloadRecording(t.id);
    } catch (erro) {
      // Um trecho que nao baixa nao pode derrubar a ligacao inteira: os outros
      // ainda servem. So loga e segue.
      console.warn(
        `[suite360:preview] req=${requestId} trecho #${t.indice} (${t.id}) ` +
          `nao baixou: ${getErrorMessage(erro)}`,
      );
      continue;
    }
    arquivos[t.indice] = caminho;
    const tamanho = await tamanhoDoArquivo(caminho);
    if (tamanho > melhorTamanho) {
      melhorTamanho = tamanho;
      melhor = t.indice;
    }
  }

  if (melhorTamanho < 0) {
    throw new AppError({
      statusCode: 502,
      code: "RECORDING_DOWNLOAD_FAILED",
      message: "Nenhum trecho da gravacao pode ser baixado do GoTo.",
    });
  }

  return {
    indice: melhor,
    criterio: `maior arquivo baixado (${Math.round(melhorTamanho / 1024)} KB)`,
    arquivos,
  };
}

// Quem atendeu cada perna da chamada, em uma linha. E aqui que a transferencia
// fica visivel para quem le o chamado depois: "#1 Ana - Suporte (ramal 101, 45s)
// -> #2 Bruno - Fiscal (ramal 205, 7m10s)". A informacao sempre esteve no
// relatorio; o que faltava era nao joga-la fora na leitura.
function resumirTrechosParaNota(
  trechos: TrechoGravacao[],
  indiceUsado: number,
): string {
  return trechos
    .map((t) => {
      // O nome do GoTo vem como "NOME - SETOR"; fica como esta, que ja diz o setor.
      const quem = t.nome || (t.ramal ? `ramal ${t.ramal}` : "atendente nao identificado");
      // Abaixo de um minuto sai so "45s". formatarDuracaoSeg diria "0m 45s",
      // que e o formato certo para a duracao da chamada mas estranho para um
      // trecho curto de transferencia — e a funcao compartilhada fica como esta.
      const dur =
        t.duracaoSeg === null
          ? ""
          : t.duracaoSeg < 60
            ? `${Math.round(t.duracaoSeg)}s`
            : formatarDuracaoSeg(t.duracaoSeg);
      const detalhes = [t.nome && t.ramal ? `ramal ${t.ramal}` : "", dur].filter(
        Boolean,
      );
      return (
        `#${t.indice + 1} ${quem}` +
        (detalhes.length ? ` (${detalhes.join(", ")})` : "") +
        (t.indice === indiceUsado ? " [transcrito]" : "")
      );
    })
    .join(" -> ");
}

// Trecho principal sem fala nenhuma: tenta os demais, do maior para o menor,
// antes de dizer que a ligacao esta muda. Sem isto, uma ligacao onde o trecho
// mais longo e so musica de espera voltaria como AUDIO_SEM_FALA.
async function transcreverAlternativos(opts: {
  trechos: TrechoGravacao[];
  pular: number;
  arquivos?: Record<number, string>;
  ramal: string;
  usuario: string;
  nomesConhecidos: string[];
  conversationSpaceId: string;
  requestId: string;
}): Promise<{ texto: string; indice: number | null }> {
  const candidatos = opts.trechos
    .filter((t) => t.indice !== opts.pular)
    .sort((a, b) => (b.duracaoSeg ?? 0) - (a.duracaoSeg ?? 0));

  for (const t of candidatos) {
    let caminho: string;
    try {
      caminho = opts.arquivos?.[t.indice] ?? (await downloadRecording(t.id));
    } catch {
      continue;
    }
    try {
      const r = await transcreverAudio({
        audioPath: caminho,
        ramal: opts.ramal,
        usuario: opts.usuario,
        nomesConhecidos: opts.nomesConhecidos,
        fonte: "ligacao",
        itemId: opts.conversationSpaceId,
      });
      const texto = String(r.transcript || "").trim();
      if (texto) {
        console.log(
          `[suite360:preview] req=${opts.requestId} trecho principal sem fala; ` +
            `usando o #${t.indice} no lugar.`,
        );
        return { texto, indice: t.indice };
      }
    } catch (erro) {
      const code = erro instanceof AppError ? erro.code : "";
      if (code === "AUDIO_SEM_FALA") continue;
      throw erro;
    }
  }
  return { texto: "", indice: null };
}

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
        report.callEnded ||
          report.endTime ||
          report.end ||
          fallbackEndedAt ||
          "",
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
        message:
          "Relatorio da chamada ainda nao esta pronto. Tente em instantes.",
      });
    }

    const trechos = extractRecordings(report);
    const recordingIds = trechos.map((t) => t.id);

    if (!recordingIds.length) {
      throw new AppError({
        statusCode: 404,
        code: "RECORDING_NOT_FOUND",
        message:
          "Gravacao ainda nao disponivel para esta chamada. Tente novamente em instantes.",
      });
    }

    const analise = analisarChamada(report);

    // Quem atendeu, e em que evidencia isso se apoiou. Os campos que a conta
    // real devolve por participante nao sao documentados publicamente pelo
    // GoTo — este log e o que permite conferir a regra na primeira
    // transferencia de verdade e afinar decidirAtendeu() sem adivinhar.
    {
      const linhas = [
        ...(analise?.caller ? [analise.caller] : []),
        ...(analise?.answerers || []),
      ];
      if (linhas.length > 1) {
        console.log(
          `[suite360:preview] req=${requestId} conv=${conversationSpaceId} atendimento: ` +
            linhas
              .map(
                (l) =>
                  `${l.ramal}${l.nome ? `(${l.nome})` : ""}` +
                  `=${l.atendeu === true ? "ATENDEU" : l.atendeu === false ? "nao" : "?"}` +
                  `[${l.atendeuPor || "-"}]`,
              )
              .join(" "),
        );
      }
    }
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
    // Lista de setores para a IA poder sugerir setores ADICIONAIS ao do perfil.
    const setoresDisponiveis = await buscarSetores().catch(() => []);

    // Cache do preview: se esta ligacao JA foi processada (transcrita + resumida) e
    // o chamado ainda nao foi criado, reaproveita o resultado — sem re-baixar a
    // gravacao, re-transcrever nem re-resumir. `forcarReprocesso` no corpo ignora
    // o cache (escotilha de seguranca; o app normal nao envia).
    const forcarReprocesso = body?.forcarReprocesso === true;
    const cache = forcarReprocesso
      ? null
      : await getPreviewCache(
          conversationSpaceId,
          PROMPT_VERSION,
          TRECHO_ESTRATEGIA_VERSAO,
        ).catch(() => null);

    let transcript: string;
    let gravacaoNota: string;
    let resumo: ResumoJson;
    let iaOk = true;
    // Indice do trecho que foi transcrito — vai para o app, para o player abrir
    // no mesmo audio que gerou o texto do chamado.
    let trechoPrincipal = 0;

    if (cache) {
      transcript = cache.transcript;
      gravacaoNota = cache.gravacaoNota;
      resumo = cache.resumo as ResumoJson;
      iaOk = cache.iaOk;
      trechoPrincipal = cache.trechoPrincipal ?? 0;
      console.log(
        `[suite360:preview] req=${requestId} conv=${conversationSpaceId} ` +
          "cache HIT — reaproveitando transcricao/resumo (sem reprocessar).",
      );
    } else {
      // Transcreve APENAS o trecho principal da chamada.
      //
      // Antes transcrevia todos e concatenava com "--- Trecho i/N ---". Numa
      // transferencia isso pagava IA por cada perna da ligacao — e as pernas
      // curtas ("vou te passar pro fiscal") so atrapalhavam o resumo. O trecho
      // principal e onde o assunto foi tratado; os outros continuam baixaveis
      // pelo player, para quem quiser ouvir.
      const escolha = await escolherTrechoPrincipal(trechos, requestId);
      const principal = trechos[escolha.indice];
      console.log(
        `[suite360:preview] req=${requestId} conv=${conversationSpaceId} ` +
          `trecho principal=#${escolha.indice} de ${trechos.length} ` +
          `por "${escolha.criterio}" | ${descreverTrechos(trechos)}`,
      );

      // Qual trecho REALMENTE gerou o texto. Comeca no escolhido, mas pode
      // mudar: se o principal estiver mudo, o fallback usa outro — e ai o
      // indice tem que acompanhar, senao o player abre num trecho silencioso
      // enquanto o chamado mostra o texto de outro.
      let indiceUsado = escolha.indice;
      try {
        const audioPath =
          escolha.arquivos?.[escolha.indice] ??
          (await downloadRecording(principal.id));
        try {
          const t = await transcreverAudio({
            audioPath,
            ramal: ramalUsuario,
            usuario: nomeUsuario,
            nomesConhecidos,
            fonte: "ligacao",
            itemId: conversationSpaceId,
          });
          transcript = String(t.transcript || "").trim();
        } catch (error) {
          const code = error instanceof AppError ? error.code : "";
          // Trecho principal mudo: em vez de falhar direto, tenta os outros na
          // ordem de tamanho. So desiste quando TODOS estiverem sem fala.
          if (code !== "AUDIO_SEM_FALA") throw error;
          const alt = await transcreverAlternativos({
            trechos,
            pular: escolha.indice,
            arquivos: escolha.arquivos,
            ramal: ramalUsuario,
            usuario: nomeUsuario,
            nomesConhecidos,
            conversationSpaceId,
            requestId,
          });
          transcript = alt.texto;
          if (alt.indice !== null) indiceUsado = alt.indice;
        }
        if (!transcript.trim()) {
          throw new AppError({
            statusCode: 422,
            code: "AUDIO_SEM_FALA",
            message: "Nenhuma fala foi detectada no audio.",
          });
        }
      } finally {
        // Em `finally` porque os dois `throw` acima sao caminhos normais (audio
        // mudo, gravacao indisponivel). Fora daqui, uma ligacao que falha
        // repetidamente ia enchendo o /tmp — que em serverless e compartilhado
        // entre invocacoes da mesma instancia e tem teto de disco.
        Object.entries(escolha.arquivos ?? {}).forEach(([idx, caminho]) => {
          if (Number(idx) !== indiceUsado) apagarTmp(caminho);
        });
      }

      const usado = trechos[indiceUsado] ?? principal;
      trechoPrincipal = indiceUsado;
      await salvarTrechoPrincipal(conversationSpaceId, indiceUsado).catch(
        () => undefined,
      );
      gravacaoNota =
        trechos.length > 1
          ? `Gravacao disponivel no GoTo (${trechos.length} trechos; ` +
            `transcrito o #${indiceUsado + 1}: ${usado.id}). ` +
            `Trechos: ${resumirTrechosParaNota(trechos, indiceUsado)}.`
          : `Gravacao disponivel no GoTo (1 trecho: ${usado.id}).`;

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
          setoresDisponiveis: setoresDisponiveis.map((s) => ({
            id: s.id,
            nome: s.nome,
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
        resumo = resumoVazio();
      }

      // So guarda no cache quando deu tudo certo (transcricao + resumo). Se a IA
      // falhou, NAO cacheia — assim reabrir tenta de novo em vez de fixar o vazio.
      if (iaOk) {
        await salvarPreviewCache(conversationSpaceId, {
          transcript,
          resumo,
          iaOk,
          gravacaoNota,
          promptVersion: PROMPT_VERSION,
          estrategiaVersao: TRECHO_ESTRATEGIA_VERSAO,
          trechoPrincipal,
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
          cliente = {
            status: "encontrado",
            cliente: porMencao,
            via: "ia_mencao",
          };
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
      ? {
          id: setorIdPerfil,
          nome: setorNomePerfil || undefined,
          fonte: "perfil",
        }
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
    // Em ligacao o relatorio do GoTo ja diz se foi ramal-a-ramal: isso vale mais
    // que o palpite da IA sobre "assunto interno".
    const refs = await montarRefs({
      resumo,
      tipo,
      origem,
      setor,
      executor,
      clienteId: clienteEncontrado?.id,
      isInternoSistema: analise?.tipo === "interno",
      // Quem atendeu a ligacao entra como usuario vinculado. Numa transferencia
      // sao varias pessoas, e todas participaram do atendimento — o chamado
      // precisa refleti-las. `answerers` ja vem filtrado: quem so ouviu o
      // telefone tocar nao esta aqui (ver decidirAtendeu no goto.controller).
      atendentesNomes: (analise?.answerers || []).map((a) => a.nome),
    });

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
          // Indice do trecho que gerou a transcricao. O player abre neste, para
          // o audio ouvido bater com o texto que foi para o chamado.
          trechoPrincipal,
        },
        ia: resumo,
        transcricao: transcript,
        gravacao: gravacaoNota,
        cliente,
        refs,
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
  const body = ensureBodyObject(req.body);
  const conversationSpaceId =
    getOptionalString(body, "conversationSpaceId") || "";

  await fluxoCriarChamado({
    res,
    requestId: randomUUID(),
    body,
    ns: "goto",
    chave: conversationSpaceId,
    fonteCusto: "ligacao",
    logTag: "suite360:criar",
    msgJaExistia: (p) =>
      `Chamado ja gerado para esta ligacao${p ? ": " + p : ""}.`,
    // Marca a ligacao como "em tratamento" antes de criar: corta o
    // escalonamento de 25s que avisaria os outros atendentes.
    antes: async () => {
      if (conversationSpaceId) {
        await marcarChamadoAberto(conversationSpaceId).catch(() => undefined);
      }
    },
    // O aviso vale INCLUSIVE em dry-run e no caminho "ja existia": o objetivo e
    // desabilitar o botao em TODAS as maquinas, nao registrar a criacao.
    depois: async () => {
      if (conversationSpaceId)
        await broadcastChamadoCriado(conversationSpaceId);
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

export async function suiteSetoresController(req: Request, res: Response) {
  const itens = await buscarSetores();
  // A API de setores nao aceita busca, e a lista e curta — entao filtramos
  // aqui. Sem isto o combo de "setores vinculados" ignorava o que o usuario
  // digitava e continuava listando tudo.
  const q = queryQ(req);
  if (!q) {
    res.status(200).json({ ok: true, data: { itens } });
    return;
  }
  const alvo = q
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  const filtrados = itens.filter((s) =>
    s.nome
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .includes(alvo),
  );
  res.status(200).json({ ok: true, data: { itens: filtrados } });
}

export async function suiteOrigensController(_req: Request, res: Response) {
  const itens = await buscarOrigens();
  res.status(200).json({ ok: true, data: { itens } });
}

export async function suiteUsuariosController(req: Request, res: Response) {
  // Aceita `setorId=6` (um) e `setorIds=6,4` (varios). O modal manda a lista de
  // setores do chamado para os "usuarios vinculados" saírem filtrados; o
  // executor continua mandando um so.
  const um =
    typeof req.query.setorId === "string" ? req.query.setorId.trim() : "";
  const varios =
    typeof req.query.setorIds === "string"
      ? req.query.setorIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const setores = varios.length ? varios : um ? [um] : [];
  const { itens, filtradoPorSetor } = await buscarUsuarios(
    queryQ(req),
    setores,
  );
  res.status(200).json({ ok: true, data: { itens, filtradoPorSetor } });
}

// GET /suite360/tipos/:id/campos — campos personalizados do assunto escolhido.
// Assunto sem campos devolve lista vazia e o modal segue igual ao de sempre.
export async function suiteCamposTipoController(req: Request, res: Response) {
  const tipoId = String(req.params.id || "").trim();
  if (!tipoId) {
    throw new AppError({
      statusCode: 400,
      code: "TIPO_ID_REQUIRED",
      message: "Informe o id do assunto.",
    });
  }
  const itens = await buscarCamposDoTipo(tipoId);
  res.status(200).json({ ok: true, data: { itens } });
}

// GET /suite360/processos?setorId=&q= — processos vinculaveis ao chamado.
export async function suiteProcessosController(req: Request, res: Response) {
  const setorId =
    typeof req.query.setorId === "string" ? req.query.setorId.trim() : "";
  const itens = await buscarProcessos(setorId, queryQ(req));
  res.status(200).json({ ok: true, data: { itens } });
}

// GET /suite360/preview-executor — quem ficaria responsavel pela conclusao,
// para o modal mostrar antes de enviar (e evitar um 422 do Suite).
export async function suitePreviewExecutorController(
  req: Request,
  res: Response,
) {
  const q = (nome: string) =>
    typeof req.query[nome] === "string"
      ? String(req.query[nome]).trim() || undefined
      : undefined;
  const tipo = q("responsavel_conclusao_tipo");
  const resultado = await previewExecutor({
    cliente_id: q("cliente_id"),
    tipo_apontamento_id: q("tipo_apontamento_id"),
    executor_id: q("executor_id"),
    responsavel_conclusao_tipo:
      tipo === "RESPONSAVEL_SETOR_EMPRESA" || tipo === "PERSONALIZADO"
        ? tipo
        : undefined,
    responsavel_conclusao_id: q("responsavel_conclusao_id"),
    setor_responsavel_conclusao_id: q("setor_responsavel_conclusao_id"),
  });
  res.status(200).json({ ok: true, data: resultado });
}
