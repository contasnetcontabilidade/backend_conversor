// Sugestoes do chamado que o preview entrega ao modal.
//
// Os 4 previews ja resolviam tipo/origem/setor/executor cada um do seu jeito
// (env, perfil, lookup do GoTo) — isso continua onde esta. O que este modulo faz
// e transformar as sugestoes NOVAS da IA em ids utilizaveis e devolver tudo num
// formato unico, para o app so precisar ler `refs`.
//
// Politica: nenhuma sugestao entra "no chute". Toda funcao aqui prefere devolver
// vazio a devolver algo errado — campo vazio o humano preenche em 1 clique;
// campo errado vira chamado errado, que e o que custa caro.

import type { ResumoJson } from "./gemini";
import {
  buscarCamposDoTipo,
  buscarSetores,
  buscarUsuarios,
  previewExecutor,
  type CampoPersonalizado,
  type ItemLista,
  type PreviewExecutor,
  type RefResolvida,
} from "./suite360";
import {
  ehDataISOValida,
  ehDataPassada,
  ehCompetenciaValida,
} from "../utils/datas";

export type FonteRef = RefResolvida["fonte"];

export interface RefValor<T> {
  valor?: T;
  fonte: FonteRef;
  motivo?: string;
}

export interface RefMulti {
  ids: string[];
  itens: Array<{ id: string; nome: string }>;
  // O que a IA citou e nao foi encontrado no Suite. O modal mostra para o
  // usuario decidir a mao — silenciar isso esconderia uma sugestao valida.
  naoResolvidos: string[];
  fonte: FonteRef;
}

export interface RefsChamado {
  tipo: RefResolvida;
  origem: RefResolvida;
  setor: RefResolvida;
  executor: RefResolvida;

  titulo: RefValor<string>;
  competencia: RefValor<string>;
  prioridade: RefValor<number>;
  isInterno: RefValor<boolean>;
  prazo: RefValor<string>;
  finalizaApontamento: RefValor<boolean>;
  visibilidade: RefValor<string>;
  enviarEmails: RefValor<boolean>;
  executorModo: RefValor<string>;

  setoresVinculados: RefMulti;
  usuariosVinculados: RefMulti;

  camposPersonalizados: {
    definicoes: CampoPersonalizado[];
    obrigatorios: string[];
  };
  previewExecutor?: PreviewExecutor;
}

function norm(s: string | undefined): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

// Setores sugeridos pela IA, validados contra a lista real do Suite.
// O setor do perfil (jaIncluidos) SEMPRE entra e vem primeiro: a regra de
// produto e "o perfil manda, a IA so acrescenta".
export async function resolverSetoresSugeridos(
  sugeridos: Array<{ id?: string; nome?: string }>,
  jaIncluidos: Array<{ id: string; nome?: string }> = [],
): Promise<RefMulti> {
  const base: Array<{ id: string; nome: string }> = jaIncluidos
    .filter((s) => s.id)
    .map((s) => ({ id: String(s.id), nome: s.nome || "" }));

  if (!sugeridos.length) {
    return {
      ids: base.map((s) => s.id),
      itens: base,
      naoResolvidos: [],
      fonte: base.length ? "perfil" : "ausente",
    };
  }

  let lista: ItemLista[] = [];
  try {
    lista = await buscarSetores();
  } catch {
    // Sem a lista nao da para validar nada: fica so o setor do perfil.
    return {
      ids: base.map((s) => s.id),
      itens: base,
      naoResolvidos: sugeridos.map((s) => s.nome || "").filter(Boolean),
      fonte: base.length ? "perfil" : "ausente",
    };
  }

  const vistos = new Set(base.map((s) => s.id));
  const itens = [...base];
  const naoResolvidos: string[] = [];

  for (const sug of sugeridos) {
    const porId = sug.id
      ? lista.find((s) => String(s.id) === String(sug.id))
      : undefined;
    const achado =
      porId ||
      (sug.nome
        ? lista.find((s) => norm(s.nome) === norm(sug.nome))
        : undefined);
    if (!achado) {
      if (sug.nome) naoResolvidos.push(sug.nome);
      continue;
    }
    if (vistos.has(achado.id)) continue; // ja veio do perfil
    vistos.add(achado.id);
    itens.push({ id: achado.id, nome: achado.nome });
  }

  return {
    ids: itens.map((s) => s.id),
    itens,
    naoResolvidos,
    fonte:
      itens.length > base.length ? "ia" : base.length ? "perfil" : "ausente",
  };
}

// Pessoas citadas pela IA -> ids de usuario.
//
// Traz a lista COMPLETA uma vez e casa localmente, em vez de uma busca por
// nome: alem de mais barato, e o unico jeito de detectar que "Ana" e ambiguo
// contra a base inteira (uma busca por "Ana" que devolve 1 resultado nao prova
// que existe so uma Ana). Nome ambiguo NAO vira sugestao.
export async function resolverUsuariosPorNomes(
  nomes: string[],
  opts: { limite?: number; fonte?: RefMulti["fonte"] } = {},
): Promise<RefMulti> {
  // O limite era fixo em 5 porque a unica origem era a IA (nomes citados na
  // conversa). Agora tambem entram os ATENDENTES da ligacao — numa fila com
  // transferencia isso passa de 5 facil, e cortar mudos os ultimos seria pior
  // que resolver todos.
  const limite = opts.limite ?? 5;
  const limpos = nomes
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, limite);
  if (!limpos.length) {
    return { ids: [], itens: [], naoResolvidos: [], fonte: "ausente" };
  }

  let lista: ItemLista[] = [];
  try {
    lista = (await buscarUsuarios()).itens;
  } catch {
    return { ids: [], itens: [], naoResolvidos: limpos, fonte: "ausente" };
  }

  const itens: Array<{ id: string; nome: string }> = [];
  const naoResolvidos: string[] = [];
  const vistos = new Set<string>();

  for (const nome of limpos) {
    const alvo = norm(nome);
    let candidatos = lista.filter((u) => norm(u.nome) === alvo);
    if (!candidatos.length) {
      // Primeiro nome tambem serve, desde que so uma pessoa comece com ele.
      candidatos = lista.filter((u) => norm(u.nome).split(" ")[0] === alvo);
    }
    if (candidatos.length !== 1) {
      naoResolvidos.push(nome); // 0 = nao existe; 2+ = ambiguo. Humano decide.
      continue;
    }
    const u = candidatos[0];
    if (vistos.has(u.id)) continue;
    vistos.add(u.id);
    itens.push({ id: u.id, nome: u.nome });
  }

  return {
    ids: itens.map((u) => u.id),
    itens,
    naoResolvidos,
    fonte: itens.length ? opts.fonte || "ia" : "ausente",
  };
}

// Tira o " - SETOR" que o GoTo cola no nome do ramal ("ANA PAULA - SUPORTE").
// O Suite guarda so o nome da pessoa, entao sem isto nenhum atendente casaria.
export function nomeSemSetor(nome: string): string {
  const i = (nome || "").lastIndexOf(" - ");
  return (i >= 0 ? nome.slice(0, i) : nome || "").trim();
}

export function resolverCompetencia(v?: string): RefValor<string> {
  const s = (v || "").trim();
  if (!s) return { fonte: "ausente" };
  if (!ehCompetenciaValida(s)) {
    return {
      fonte: "ausente",
      motivo: `competencia ignorada (formato "${s}")`,
    };
  }
  return { valor: s, fonte: "ia" };
}

export function resolverPrioridade(v?: string): RefValor<number> {
  const s = (v || "").trim();
  // "" e a saida de "nao sei" — nesse caso o Suite aplica o padrao (2=Media).
  if (!s || !["1", "2", "3", "4"].includes(s)) return { fonte: "ausente" };
  return { valor: Number(s), fonte: "ia" };
}

export function resolverPrazoPersonalizado(v?: string): RefValor<string> {
  const s = (v || "").trim();
  if (!s) return { fonte: "ausente" };
  if (!ehDataISOValida(s)) {
    return { fonte: "ausente", motivo: `prazo ignorado (formato "${s}")` };
  }
  if (ehDataPassada(s)) {
    // A API recusa prazo no passado. Descartar aqui e melhor que levar um 422
    // depois de o usuario ter revisado tudo.
    return { fonte: "ausente", motivo: `prazo ${s} ja passou` };
  }
  return { valor: s, fonte: "ia" };
}

// ---------------------------------------------------------------------------

export interface ContextoRefs {
  resumo: ResumoJson;
  tipo: RefResolvida;
  origem: RefResolvida;
  setor: RefResolvida;
  executor: RefResolvida;
  clienteId?: string;
  // Em ligacao o proprio relatorio do GoTo diz se foi ramal-a-ramal; isso vale
  // mais que o palpite da IA.
  isInternoSistema?: boolean;
  // Nomes de quem REALMENTE atendeu a ligacao (ja filtrado por analisarChamada:
  // quem so ouviu tocar nao vem aqui). Entram como usuarios vinculados, antes
  // dos nomes que a IA citou — sao fato do relatorio, nao interpretacao.
  atendentesNomes?: string[];
}

// Quem vincular ao chamado: primeiro quem atendeu a ligacao (fato do
// relatorio), depois quem a IA citou na conversa (interpretacao). A ordem
// importa porque o limite corta o fim da lista.
function nomesParaVincular(ctx: ContextoRefs): string[] {
  const atendentes = (ctx.atendentesNomes || [])
    .map(nomeSemSetor)
    .filter((n) => n.length >= 2);
  const daIa = (ctx.resumo.pessoas_mencionadas || []).map((n) => (n || "").trim());
  const vistos = new Set<string>();
  return [...atendentes, ...daIa].filter((n) => {
    const k = n.toLowerCase();
    if (!n || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

export async function montarRefs(ctx: ContextoRefs): Promise<RefsChamado> {
  const { resumo, tipo, origem, setor, executor } = ctx;

  const [setoresVinculados, usuariosVinculados, definicoes, prev] =
    await Promise.all([
      resolverSetoresSugeridos(
        resumo.setores_sugeridos || [],
        setor.id ? [{ id: setor.id, nome: setor.nome }] : [],
      ).catch((): RefMulti => ({
        ids: setor.id ? [setor.id] : [],
        itens: setor.id ? [{ id: setor.id, nome: setor.nome || "" }] : [],
        naoResolvidos: [],
        fonte: setor.id ? "perfil" : "ausente",
      })),
      resolverUsuariosPorNomes(nomesParaVincular(ctx), {
        // Atendentes + citados pela IA cabem numa fila grande; 12 e folgado o
        // bastante e ainda limita o custo da resolucao.
        limite: 12,
        fonte: (ctx.atendentesNomes || []).length ? "ligacao" : "ia",
      }).catch(
        (): RefMulti => ({
          ids: [],
          itens: [],
          naoResolvidos: [],
          fonte: "ausente",
        }),
      ),
      tipo.id
        ? buscarCamposDoTipo(tipo.id).catch((): CampoPersonalizado[] => [])
        : Promise.resolve([] as CampoPersonalizado[]),
      // Best-effort e read-only: e justamente aqui que ele evita o 422.
      ctx.clienteId
        ? previewExecutor({
            cliente_id: ctx.clienteId,
            tipo_apontamento_id: tipo.id,
            executor_id: executor.id,
          }).catch((): PreviewExecutor => ({ ok: false }))
        : Promise.resolve(undefined),
    ]);

  // "Ja resolvido" com cinto e suspensorio: a IA precisa dizer que sim E nao
  // ter sobrado providencia. Um chamado nascer fechado por engano e pior que
  // nascer aberto sem precisar.
  const semPendencia = (resumo.providencias_sugeridas || []).length === 0;
  const iaDizResolvido = resumo.ja_resolvido === "sim";
  const finalizar = iaDizResolvido && semPendencia;

  const interno =
    ctx.isInternoSistema !== undefined
      ? { valor: ctx.isInternoSistema, fonte: "lookup" as FonteRef }
      : resumo.assunto_interno === "sim"
        ? { valor: true, fonte: "ia" as FonteRef }
        : resumo.assunto_interno === "nao"
          ? { valor: false, fonte: "ia" as FonteRef }
          : { fonte: "ausente" as FonteRef };

  return {
    tipo,
    origem,
    setor,
    executor,

    titulo: resumo.titulo
      ? { valor: resumo.titulo, fonte: "ia" }
      : { fonte: "ausente" },
    competencia: resolverCompetencia(resumo.competencia),
    prioridade: resolverPrioridade(resumo.prioridade),
    isInterno: interno,
    prazo: resolverPrazoPersonalizado(resumo.prazo_mencionado),
    finalizaApontamento: {
      valor: finalizar,
      fonte: finalizar ? "ia" : "ausente",
      // O motivo alimenta o texto do destaque no modal: o usuario precisa saber
      // POR QUE a caixa "criar ja finalizado" veio marcada.
      motivo: finalizar
        ? "A IA nao encontrou pendencia neste atendimento."
        : iaDizResolvido && !semPendencia
          ? "A IA indicou providencias em aberto."
          : undefined,
    },
    // Defaults do sistema; existem no refs para o app nao ter regra propria.
    visibilidade: { valor: "publico", fonte: "env" },
    enviarEmails: { valor: false, fonte: "env" },
    executorModo: { valor: "eu", fonte: "perfil" },

    setoresVinculados,
    usuariosVinculados,

    camposPersonalizados: {
      definicoes,
      obrigatorios: definicoes.filter((d) => d.obrigatorio).map((d) => d.id),
    },
    previewExecutor: prev,
  };
}
