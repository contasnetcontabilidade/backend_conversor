// Fluxo unico de criacao de chamado, compartilhado pelas 4 fontes.
//
// Antes disto, goto/gmail/chat/gravacao tinham a MESMA sequencia copiada:
// montar body -> validar -> dry-run -> idempotencia -> lock -> criar -> custo ->
// responder. Quatro copias que ja divergiam entre si; a mais completa era a do
// goto, e e ela que virou o padrao aqui.
//
// Uma divergencia era um BUG de producao: gmail/chat/gravacao respondiam ao
// dry-run ANTES do bloco de idempotencia. Como o sistema roda em
// SUITE360_DRY_RUN=1, na pratica 3 das 4 fontes nao tinham NENHUMA protecao
// contra duplicata. Aqui a idempotencia vale nos dois modos.

import type { Response } from "express";
import { AppError, getErrorMessage } from "../lib/errors";
import { registrarCustoChamado } from "./custoChamados";
import {
  getChamadoCriado,
  liberarCriacao,
  reservarCriacao,
  salvarChamadoCriado,
} from "./store";
import { campoBool, montarChamadoBodyDaRequisicao } from "./chamadoPayload";
import {
  buscarCamposDoTipo,
  criarChamado,
  isDryRun,
  validarChamadoBody,
  type ChamadoBody,
} from "./suite360";

// Em dry-run a idempotencia usa TTL curto para dar para re-testar o mesmo item
// varias vezes durante o desenvolvimento sem esperar 30 dias.
const TTL_DRY_RUN_SEG = 600;
const TTL_PRODUCAO_SEG = 30 * 24 * 3600;

export interface DepoisInfo {
  jaExistia: boolean;
  dryRun: boolean;
  id: string;
  protocolo: string;
}

export interface FluxoCriarOpts {
  res: Response;
  requestId: string;
  body: Record<string, unknown>;
  ns: string; // namespace de idempotencia: goto | gmail | chat | gravacao
  chave: string; // id de idempotencia ("" = sem idempotencia)
  fonteCusto: "ligacao" | "email" | "chat" | "gravacao";
  logTag: string;
  msgJaExistia: (protocolo: string) => string;
  antes?: () => Promise<void>;
  depois?: (info: DepoisInfo) => Promise<void>;
}

export async function fluxoCriarChamado(opts: FluxoCriarOpts): Promise<void> {
  const { res, requestId, body, ns, chave, fonteCusto, logTag } = opts;
  const dryRun = isDryRun();

  const { chamado, avisos } = montarChamadoBodyDaRequisicao(body);
  const { faltando, invalidos } = validarChamadoBody(chamado);

  // Campos personalizados obrigatorios do assunto escolhido. Best-effort: se o
  // lookup falhar, seguimos e avisamos — travar a criacao por causa de uma
  // consulta instavel e pior que deixar o Suite recusar com mensagem propria.
  const faltandoCampos = await conferirCamposObrigatorios(chamado, avisos);
  faltando.push(...faltandoCampos);

  if ((faltando.length || invalidos.length) && !dryRun) {
    throw new AppError({
      statusCode: 422,
      code: "SUITE_CAMPOS_OBRIGATORIOS",
      message:
        "Faltam dados obrigatorios para abrir o chamado. Corrija/configure antes de enviar.",
      details: { faltando, invalidos },
    });
  }

  await opts.antes?.();

  // Dry-run com body incompleto nao e uma criacao: so mostra o que falta, sem
  // gastar lock nem gravar idempotencia (o usuario ainda vai corrigir e reenviar).
  if (dryRun && (faltando.length || invalidos.length)) {
    const resultado = await criarChamado(chamado as ChamadoBody);
    console.log(
      `[${logTag}] req=${requestId} chave=${chave || "-"} DRY-RUN incompleto ` +
        `faltando=[${faltando.join(",")}] invalidos=[${invalidos.join(",")}]`,
    );
    res.status(200).json({
      ok: true,
      data: {
        requestId,
        dryRun: true,
        faltando,
        invalidos,
        avisos,
        mensagem:
          "Simulado — ainda faltam dados para envio real: " +
          [...faltando, ...invalidos].join(", "),
        body: resultado.body,
      },
    });
    return;
  }

  // Escotilha de desenvolvimento: com a idempotencia valendo em dry-run,
  // re-testar o mesmo e-mail/gravacao responderia "ja existia" por 10 minutos.
  // campoBool porque em multipart o valor chega como a string "true".
  const forcar = dryRun && campoBool(body, "forcarRecriacao") === true;

  if (chave && !forcar) {
    const jaCriado = await getChamadoCriado(chave, ns).catch(() => null);
    if (jaCriado) {
      await opts.depois?.({
        jaExistia: true,
        dryRun,
        id: jaCriado.id,
        protocolo: jaCriado.protocolo,
      });
      console.log(
        `[${logTag}] req=${requestId} chave=${chave} JA EXISTIA protocolo=${jaCriado.protocolo || "-"}`,
      );
      res.status(200).json({
        ok: true,
        data: {
          requestId,
          dryRun,
          jaExistia: true,
          id: jaCriado.id,
          protocolo: jaCriado.protocolo,
          avisos,
          mensagem: opts.msgJaExistia(jaCriado.protocolo),
        },
      });
      return;
    }
  }

  if (chave) {
    const reservou = await reservarCriacao(chave, ns).catch(() => true);
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
    resultado = await criarChamado(chamado as ChamadoBody);
  } catch (error) {
    if (chave) await liberarCriacao(chave, ns).catch(() => undefined);
    throw error;
  }

  const protocolo = resultado.protocolo || "";
  const id = resultado.id || "";
  const meta = resultado.meta;
  const avisosFinais = [...avisos, ...(meta?.avisos || [])];

  // Antes de gravar a idempotencia, para o caminho "ja existia" conseguir
  // reexibir este aviso depois.
  if (!dryRun && chamado.cliente_ids && chamado.cliente_ids.length > 1) {
    avisosFinais.push(
      `O custo de IA foi atribuido a empresa principal (o chamado abriu para ${chamado.cliente_ids.length} empresas).`,
    );
  }

  if (chave) {
    // Se o registro de idempotencia falhar, NAO liberar a reserva: ela e a
    // unica barreira que resta contra criar o mesmo chamado duas vezes. Deixar
    // o TTL de 120s expirar sozinho e mais seguro que abrir a janela agora.
    let registrou = true;
    await salvarChamadoCriado(
      chave,
      {
        id,
        protocolo,
        // Guardados para o caminho "ja existia" conseguir reexibir o lote.
        ...(meta?.protocolos.length ? { protocolos: meta.protocolos } : {}),
        ...(meta?.grupoId ? { grupoId: meta.grupoId } : {}),
        ...(avisosFinais.length ? { avisos: avisosFinais } : {}),
      },
      ns,
      dryRun ? TTL_DRY_RUN_SEG : TTL_PRODUCAO_SEG,
    ).catch((erro) => {
      registrou = false;
      console.error(
        `[${logTag}] req=${requestId} chave=${chave} protocolo=${protocolo} ` +
          `NAO registrou a idempotencia: ${getErrorMessage(erro)}`,
      );
    });
    if (registrou) await liberarCriacao(chave, ns).catch(() => undefined);

    // Custo so em criacao real: em dry-run nao existe chamado para atribuir.
    if (!dryRun) {
      await registrarCustoChamado({
        itemId: chave,
        fonte: fonteCusto,
        clienteId: String(chamado.cliente_id ?? ""),
        cliente: strOpcional(body, "cliente_nome"),
        assuntoId: String(chamado.tipo_apontamento_id ?? ""),
        assunto: strOpcional(body, "assunto_nome"),
        ramal: strOpcional(body, "ramal"),
        usuario: strOpcional(body, "usuario"),
        protocolo,
      }).catch(() => undefined);
    }
  }

  await opts.depois?.({ jaExistia: false, dryRun, id, protocolo });

  if (dryRun) {
    console.log(
      `[${logTag}] req=${requestId} chave=${chave || "-"} ` +
        `cliente=${chamado.cliente_id || "-"} DRY-RUN (nao enviado)`,
    );
    res.status(200).json({
      ok: true,
      data: {
        requestId,
        dryRun: true,
        faltando,
        invalidos,
        avisos: avisosFinais,
        mensagem:
          "Chamado simulado — envio ao Suite desligado (SUITE360_DRY_RUN).",
        body: resultado.body,
      },
    });
    return;
  }

  console.log(
    `[${logTag}] req=${requestId} chave=${chave || "-"} ` +
      `cliente=${chamado.cliente_id || "-"} protocolo=${protocolo}` +
      (avisosFinais.length ? ` avisos=${avisosFinais.length}` : ""),
  );
  res.status(201).json({
    ok: true,
    data: {
      requestId,
      dryRun: false,
      id,
      protocolo,
      status: resultado.status,
      statusDescricao: resultado.statusDescricao,
      protocolos: meta?.protocolos || [],
      apontamentosIds: meta?.apontamentosIds || [],
      grupoId: meta?.grupoId,
      total: meta?.total,
      modoCriacao: meta?.modoCriacao,
      avisos: avisosFinais,
      mensagem: `Chamado criado com sucesso: ${protocolo}`,
    },
  });
}

// ---------------------------------------------------------------------------

// Le string sem lancar (getOptionalString do utils lanca em valor nao-string, o
// que aqui derrubaria a criacao por causa de um campo de telemetria).
function strOpcional(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const v = body[field];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// Devolve os campos personalizados obrigatorios que ficaram sem valor, no
// formato "campo_personalizado:<id>" — o app traduz o id para o nome do campo.
async function conferirCamposObrigatorios(
  chamado: Partial<ChamadoBody>,
  avisos: string[],
): Promise<string[]> {
  const tipoId = String(chamado.tipo_apontamento_id ?? "").trim();
  if (!tipoId) return [];

  let defs;
  try {
    defs = await buscarCamposDoTipo(tipoId);
  } catch {
    avisos.push(
      "Nao consegui conferir os campos obrigatorios deste assunto; o Suite pode recusar o envio.",
    );
    return [];
  }

  const valores = chamado.campos_personalizados || {};
  const faltando: string[] = [];
  for (const def of defs) {
    if (!def.obrigatorio) continue;
    const v = valores[def.id];
    const vazio =
      v === undefined || v === null || (typeof v === "string" && !v.trim());
    if (vazio) faltando.push(`campo_personalizado:${def.id}`);
  }
  return faltando;
}
