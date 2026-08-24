// Montagem do corpo do chamado a partir da requisicao do app.
//
// UNICO lugar onde o body do cliente vira payload do Suite360. Antes disso a
// montagem estava copiada nos 4 controllers (goto/gmail/chat/gravacao), o que
// significava editar 4 arquivos por campo novo — e divergir no primeiro fix.
//
// Duas regras que valem para tudo aqui:
//  1. WHITELIST campo a campo. Nunca espalhar o body do cliente no payload:
//     campo desconhecido que chega no Suite e 422 (ou pior, algo que ninguem
//     revisou sendo gravado no chamado).
//  2. Campo vazio NAO vai. `titulo: ""` ou `setores_vinculados: []` sao 422 de
//     graca — o Suite trata ausencia e vazio de formas diferentes. O
//     `compactar()` no fim tira tudo que e vazio, menos booleano e zero.

import { isRecord } from "../lib/errors";
import type {
  ChamadoBody,
  ModoCriacao,
  ProcessoVinculado,
  RespConclusaoTipo,
  Visibilidade,
} from "./suite360";

// Teto da descricao. Em ligacao e gravacao a transcricao inteira vai no corpo,
// entao uma reuniao longa pode estourar o limite do Suite (413). Cortar aqui,
// avisando, e melhor que o chamado inteiro ser recusado.
const DESCRICAO_MAX = 100_000;
const MARCA_CORTE = "\n\n[...conteudo truncado por limite de tamanho...]";

// ---------------------------------------------------------------------------
// Leitores tolerantes (o "criar" e JSON, mas multipart manda tudo string)
// ---------------------------------------------------------------------------

export function campoId(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

export function campoStr(
  body: Record<string, unknown>,
  field: string,
  max?: number,
): string | undefined {
  const v = body[field];
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s) return undefined;
  return max && s.length > max ? s.slice(0, max) : s;
}

// Aceita true/false, "true"/"false", "1"/"0", 1/0. Devolve undefined quando o
// campo nao veio — diferente de `false`, que e uma decisao do usuario.
export function campoBool(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const v = body[field];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "sim", "yes", "on"].includes(s)) return true;
    if (["false", "0", "nao", "não", "no", "off"].includes(s)) return false;
  }
  return undefined;
}

export function campoInt(
  body: Record<string, unknown>,
  field: string,
): number | undefined {
  const v = body[field];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

// Lista de ids: dedupe, sem vazios, com teto. Aceita array ou string solta
// (multipart manda array de 1 item como string).
export function listaDeIds(valor: unknown, max = 50): string[] {
  const bruto = Array.isArray(valor)
    ? valor
    : valor === undefined || valor === null
      ? []
      : [valor];
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const item of bruto) {
    const s = String(item ?? "").trim();
    if (!s || vistos.has(s)) continue;
    vistos.add(s);
    saida.push(s);
    if (saida.length >= max) break;
  }
  return saida;
}

function objetoPlano(valor: unknown): Record<string, unknown> | undefined {
  if (!isRecord(valor)) return undefined;
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valor)) {
    if (v === undefined || v === null || v === "") continue;
    saida[String(k)] = v;
  }
  return Object.keys(saida).length ? saida : undefined;
}

function listaDeProcessos(valor: unknown, max = 20): ProcessoVinculado[] {
  if (!Array.isArray(valor)) return [];
  const saida: ProcessoVinculado[] = [];
  for (const item of valor) {
    // O app pode mandar so o id (caso comum) ou o objeto completo.
    if (typeof item === "string" || typeof item === "number") {
      const id = String(item).trim();
      if (id) saida.push({ processo_id: id });
    } else if (isRecord(item)) {
      const id = String(item.processo_id ?? item.id ?? "").trim();
      if (!id) continue;
      const p: ProcessoVinculado = { processo_id: id };
      const gestorTipo = String(item.gestor_tipo ?? "").trim();
      if (gestorTipo) p.gestor_tipo = gestorTipo;
      const gestorUser = String(item.gestor_user_id ?? "").trim();
      if (gestorUser) p.gestor_user_id = gestorUser;
      const membros = listaDeIds(item.membros_user_ids, 50);
      if (membros.length) p.membros_user_ids = membros;
      saida.push(p);
    }
    if (saida.length >= max) break;
  }
  return saida;
}

// Remove chaves vazias. Booleanos e o zero FICAM: "enviar_emails: false" e uma
// decisao do usuario, nao um campo em branco.
function compactar<T extends Record<string, unknown>>(obj: T): T {
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && !v) continue;
    if (Array.isArray(v) && !v.length) continue;
    saida[k] = v;
  }
  return saida as T;
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

export interface PayloadMontado {
  chamado: Partial<ChamadoBody>;
  avisos: string[];
}

const MODOS_CRIACAO: ModoCriacao[] = ["independente", "agrupado_sincronizado"];
const VISIBILIDADES: Visibilidade[] = ["publico", "restrito"];

export function montarChamadoBodyDaRequisicao(
  body: Record<string, unknown>,
): PayloadMontado {
  const avisos: string[] = [];

  // --- descricao (com teto, por causa da transcricao inteira) ---
  const descricaoBruta =
    typeof body.descricao === "string" ? body.descricao : "";
  let descricao = descricaoBruta;
  if (descricao.length > DESCRICAO_MAX) {
    descricao =
      descricao.slice(0, DESCRICAO_MAX - MARCA_CORTE.length) + MARCA_CORTE;
    avisos.push(
      "A descricao era grande demais e foi cortada. Confira se o essencial ficou no texto.",
    );
  }

  // --- empresas: cliente_id sempre presente (e a chave de dedup e de custo) ---
  // Se so vier a lista (sem o principal), o primeiro item vira o principal —
  // senao o lote inteiro seria descartado e sobraria um modo_criacao orfao.
  const clienteIds = listaDeIds(body.cliente_ids, 30);
  const clienteId = campoId(body, "cliente_id") || clienteIds[0];
  const varias = clienteIds.filter((id) => id !== clienteId);
  let modoCriacao = campoStr(body, "modo_criacao") as ModoCriacao | undefined;
  if (modoCriacao && !MODOS_CRIACAO.includes(modoCriacao))
    modoCriacao = undefined;

  // --- executor / responsavel pela conclusao ---
  const exec = montarExecutor(body, avisos);

  // --- setores: dedupe, com o principal na frente ---
  const setores = listaDeIds(body.setores_vinculados, 20);

  const chamado: Partial<ChamadoBody> = compactar({
    cliente_id: clienteId,
    // So manda a lista quando ha MAIS de uma empresa. Com uma so, o cliente_id
    // sozinho ja diz tudo e a resposta volta no formato simples.
    cliente_ids:
      varias.length && clienteId ? [clienteId, ...varias] : undefined,
    modo_criacao: varias.length ? modoCriacao || "independente" : undefined,

    tipo_apontamento_id: campoId(body, "tipo_apontamento_id"),
    descricao,
    origem_id: campoId(body, "origem_id"),
    setores_vinculados: setores,

    ...exec,

    titulo: campoStr(body, "titulo", 255),
    competencia: campoStr(body, "competencia"),
    prioridade: campoInt(body, "prioridade"),
    visibilidade: (() => {
      const v = campoStr(body, "visibilidade") as Visibilidade | undefined;
      return v && VISIBILIDADES.includes(v) ? v : undefined;
    })(),
    prazo_personalizado_data: campoStr(body, "prazo_personalizado_data"),
    is_interno: campoBool(body, "is_interno"),
    usuarios_vinculados: listaDeIds(body.usuarios_vinculados, 50),
    finaliza_apontamento: campoBool(body, "finaliza_apontamento"),
    enviar_emails: campoBool(body, "enviar_emails"),
    campos_personalizados: objetoPlano(body.campos_personalizados),
    iniciar_processo: campoBool(body, "iniciar_processo"),
    processos_vinculados: listaDeProcessos(body.processos_vinculados),
    sobrescrever_prazo_processo_com_chamado: campoBool(
      body,
      "sobrescrever_prazo_processo_com_chamado",
    ),
  });

  if (modoCriacao && !varias.length) {
    avisos.push(
      "O modo de varias empresas foi ignorado: o chamado tem uma empresa so.",
    );
  }

  return { chamado, avisos };
}

// O app manda `executor_modo` ("eu" | "responsavel" | "escolher") e o backend
// deriva os campos que a API espera. Cada modo emite exatamente UM conjunto:
// mandar executor_id junto com responsavel_conclusao_* faz o Suite receber dois
// donos e decidir sozinho.
//
// "eu" e "escolher" usam `executor_id` porque a documentacao define esse campo
// como o atalho de PERSONALIZADO com o setor da conclusao vindo do PROPRIO
// executor. Montar PERSONALIZADO + setor_responsavel_conclusao_id na mao seria
// pedir 422 sempre que a pessoa escolhida nao pertencesse aquele setor — e
// "atribuir o chamado ao Fulano" e um caminho que ja funcionava antes disto.
function montarExecutor(
  body: Record<string, unknown>,
  avisos: string[],
): Partial<ChamadoBody> {
  const modo = campoStr(body, "executor_modo");
  const executorId = campoId(body, "executor_id");
  const setorConclusao = campoId(body, "setor_responsavel_conclusao_id");

  if (modo === "responsavel" || modo === "responsavel_setor_empresa") {
    // Sem aviso quando vem executor_id: o app preenche esse campo com o
    // responsavel que ELE mesmo resolveu na previa, entao avisar aqui geraria
    // um "algo deu errado" em toda criacao neste modo.
    return {
      responsavel_conclusao_tipo:
        "RESPONSAVEL_SETOR_EMPRESA" as RespConclusaoTipo,
      setor_responsavel_conclusao_id: setorConclusao,
    };
  }

  if (modo === "escolher" || modo === "personalizado") {
    return {
      executor_id: campoId(body, "responsavel_conclusao_id") || executorId,
    };
  }

  if (modo && modo !== "eu" && modo !== "executor") {
    avisos.push(
      `Modo de executor desconhecido ("${modo}") — usando o executor informado.`,
    );
  }
  // Sem modo = contrato antigo (app que ainda nao conhece os modos).
  return { executor_id: executorId };
}
