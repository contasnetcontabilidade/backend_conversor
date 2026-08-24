import { Redis } from "@upstash/redis";

// Feedback dos resumos/decisoes da IA, para refinar o prompt com DADO REAL.
// Privacidade: NUNCA guarda transcricao, texto do resumo, nem nome/CNPJ do
// cliente — apenas metadados, divergencias (sugerido x escolhido) e rating/tags.
// Lista capada no Redis (padrao dos "events"); fallback em memoria (dev).

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
const MAX = 1000; // guarda os ultimos 1000 feedbacks
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
  };
  descEditada?: boolean;
  iaOk?: boolean;
}

export async function registrarFeedback(entry: FeedbackEntry): Promise<void> {
  const json = JSON.stringify(entry);
  const r = getRedis();
  if (r) {
    await r.lpush(KEY, json);
    await r.ltrim(KEY, 0, MAX - 1);
    return;
  }
  mem.unshift(json);
  mem = mem.slice(0, MAX);
}

export async function listarFeedback(limit = 500): Promise<FeedbackEntry[]> {
  const r = getRedis();
  const raw = r
    ? (await r.lrange<string>(KEY, 0, limit - 1)) || []
    : mem.slice(0, limit);
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
