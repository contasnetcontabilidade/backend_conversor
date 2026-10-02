import { Redis } from "@upstash/redis";

// Feedback dos resumos/decisoes da IA, para refinar o prompt com DADO REAL.
// Privacidade: NUNCA guarda transcricao nem os dados do atendimento (nome/CNPJ
// do cliente) — guarda metadados, divergencias (sugerido x escolhido),
// rating/tags e o texto do RESUMO (o da IA e, se editado, o final).
// Lista SEM teto no Redis: o feedback e a base para medir o prompt e, no
// futuro, treinar sugestoes — apagar o antigo joga fora justamente esse dado.
// ~150 registros/semana de ~0,7 KB cabem folgados no plano gratuito do Upstash.
// Fallback em memoria (dev).

let redis: Redis | null = null;
function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

const KEY = "feedback:list";
// Leitura em lotes: um LRANGE da lista inteira cresceria sem limite numa
// unica resposta do Upstash.
const LOTE_LEITURA = 1000;
let mem: string[] = [];

export interface FeedbackEntry {
  ts: string;
  tipo: "explicito" | "implicito";
  origem: string; // "ligacao" | "email" | "resumo" | "chat"
  id: string; // conversationSpaceId / messageId / "" (gravador)
  promptVersion?: string; // versao do prompt vigente quando o feedback foi dado
  modelo?: string;
  ramal?: string;
  usuario?: string;
  // explicito
  rating?: "up" | "down" | null;
  tags?: string[];
  comentario?: string;
  // implicito
  divergencias?: {
    clienteMudou?: boolean;
    // Separa os dois casos que o "clienteMudou" sozinho confunde:
    // - tinha sugestao e o usuario TROCOU -> a IA/resolver errou de verdade;
    // - nao veio sugestao nenhuma          -> so nao achou (nao e erro de prompt).
    clienteTinhaSugestao?: boolean;
    clienteVia?: string; // "telefone" | "ia_mencao" | "interno" | ""
    setorMudou?: boolean;
    executorMudou?: boolean;
    // Sem isto, "executorMudou" daria true toda vez que a pessoa escolhesse o
    // modo "responsavel da empresa" — misturando erro da IA com escolha de modo.
    executorModo?: string; // "eu" | "responsavel" | "escolher"
    assuntoSugerido?: string; // categoria (nao sensivel)
    assuntoFinal?: string;
    assuntoMudou?: boolean;
    // "Criar ja finalizado": mede se a leitura da IA sobre "ja resolvido" bate
    // com o que o humano confirmou.
    finalizadoSugerido?: boolean;
    finalizadoFinal?: boolean;
    // O que a IA sugeriu ao abrir a revisao, nunca sobrescrito. O
    // finalizadoSugerido acima vira false no primeiro clique do switch, entao
    // "a IA marcou e o usuario desmarcou" nunca aparecia nos dados. Campo novo
    // (em vez de corrigir o antigo) porque app velho e novo convivem durante o
    // auto-update: ausente = app antigo.
    finalizadoIa?: boolean;
  };
  descEditada?: boolean;
  // Tamanho da edicao, sem conteudo: "descEditada" so dizia sim/nao, e 42% dos
  // chamados editavam sem dar para saber se foi enxugar, completar ou reescrever.
  descTamSistema?: number; // caracteres do texto que o sistema montou
  descTamFinal?: number; // caracteres do texto enviado
  descPalavrasMantidas?: number; // 0..1: palavras distintas do sistema que ficaram
  // O texto do resumo, para melhorar o prompt com o que a IA errou de fato.
  // So a parte editavel (resumo, pontos, providencias), nunca o cabecalho com
  // cliente/CNPJ nem a transcricao. O final so vem quando difere do da IA.
  descTextoIa?: string;
  descTextoFinal?: string;
  iaOk?: boolean;
}

export async function registrarFeedback(entry: FeedbackEntry): Promise<void> {
  const json = JSON.stringify(entry);
  const r = getRedis();
  if (r) {
    await r.lpush(KEY, json);
    return;
  }
  mem.unshift(json);
}

// Sem `limit`, devolve tudo (mais recente primeiro).
export async function listarFeedback(limit?: number): Promise<FeedbackEntry[]> {
  const r = getRedis();
  let raw: string[] = [];
  if (!r) {
    raw = limit ? mem.slice(0, limit) : mem.slice();
  } else {
    for (let inicio = 0; !limit || inicio < limit; inicio += LOTE_LEITURA) {
      const fim = inicio + LOTE_LEITURA - 1;
      const lote =
        (await r.lrange<string>(KEY, inicio, limit ? Math.min(fim, limit - 1) : fim)) || [];
      raw.push(...lote);
      if (lote.length < LOTE_LEITURA) break;
    }
  }
  return raw
    .map((item) => {
      try {
        return typeof item === "string" ? JSON.parse(item) : item;
      } catch {
        return null;
      }
    })
    .filter((e): e is FeedbackEntry => e !== null);
}
