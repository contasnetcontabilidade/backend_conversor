import { AppError } from "../lib/errors";
import { cacheGet, delValue, incrComTtl, setSeNaoExiste } from "./store";

// Fila (rate limit) por ESPACO do Google Chat.
//
// Por que existe: a Chat API limita 15 leituras/s POR ESPACO, e essa cota e
// compartilhada entre apps. A cota do projeto (3.000/min) sobra folgada mesmo
// com 180 usuarios, mas o teto por espaco e alcancavel de verdade: basta uma
// duzia de atendentes abrindo A MESMA conversa movimentada no mesmo segundo.
//
// Por que no Redis e nao em memoria: na Vercel cada invocacao serverless enxerga
// so a si mesma. Um contador em memoria de processo com 180 usuarios nao limita
// nada — cada instancia acharia que esta sozinha. O contador precisa ser atomico
// e COMPARTILHADO, e o Upstash ja esta no projeto.
//
// Quem nao tem vaga ESPERA e entra (fila), em vez de tomar erro na cara. So
// depois de CHAT_FILA_MAX_MS sem vaga e que vira erro, ja traduzido.

const TETO_POR_SEGUNDO = Number(process.env.CHAT_RPS_ESPACO) || 12;
const ESPERA_MAX_MS = Number(process.env.CHAT_FILA_MAX_MS) || 4000;
const LOCK_TTL_SEG = 10;

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Identificador curto e estavel do espaco para compor a chave do contador.
function chaveEspaco(spaceId: string): string {
  return String(spaceId || "-").replace(/^spaces\//, "");
}

// Token bucket de janela de 1 segundo.
//
// O teto padrao e 12, nao 15, de proposito: a cota por espaco e compartilhada
// com outros apps que nao passam por esta fila, entao a margem de 3 e o espaco
// que deixamos para eles antes de o Google comecar a devolver 429.
export async function comVagaNoEspaco<T>(
  spaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const alvo = chaveEspaco(spaceId);
  const inicio = Date.now();
  for (;;) {
    const segundo = Math.floor(Date.now() / 1000);
    // TTL de 2s (e nao 1s) para a chave nao sumir antes do fim da propria janela.
    const usados = await incrComTtl(`chat:rl:${alvo}:${segundo}`, 2).catch(
      () => 0, // Redis fora do ar: nao e motivo para bloquear a leitura.
    );
    if (usados <= TETO_POR_SEGUNDO) return fn();

    if (Date.now() - inicio > ESPERA_MAX_MS) {
      throw new AppError({
        statusCode: 429,
        code: "CHAT_OCUPADO",
        message:
          "Muita gente lendo essa conversa agora. Tente de novo em instantes.",
      });
    }
    // Jitter: sem ele, todos os que esperam acordariam no mesmo instante da
    // virada do segundo e estourariam o teto de novo, juntos.
    await dormir(120 + Math.random() * 180);
  }
}

// Single-flight: quando N pedidos identicos chegam com o cache frio, so UM vai
// ao Google; os outros esperam e leem o resultado que ele gravou no cache.
//
// Complementa o cache de pagina: o cache resolve o pico DEPOIS que o primeiro
// respondeu; este resolve a janela em que ninguem respondeu ainda.
export async function comSingleFlight<T>(
  chaveCache: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = `chat:lock:${chaveCache}`;
  const ganhou = await setSeNaoExiste(lock, "1", LOCK_TTL_SEG).catch(() => true);
  if (ganhou) {
    try {
      return await fn();
    } finally {
      await delValue(lock).catch(() => undefined);
    }
  }

  // Perdeu o lock: espera curta pelo resultado de quem ganhou.
  for (let tentativa = 0; tentativa < 12; tentativa++) {
    await dormir(150);
    const pronto = await cacheGet<T>(chaveCache).catch(() => null);
    if (pronto) return pronto;
  }
  // Quem ganhou o lock demorou demais ou falhou: segue sozinho em vez de travar.
  return fn();
}
