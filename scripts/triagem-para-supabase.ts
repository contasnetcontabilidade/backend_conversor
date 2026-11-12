// Leva o estado da triagem de e-mails do Redis para o Supabase, uma vez, na
// troca de 12/11/2026 (ver supabase/triagem.sql e src/services/triagemBanco.ts).
// Sem isto, cada conta do piloto recomecaria do zero: olharia o ultimo dia de
// novo, pagaria a IA outra vez pelos mesmos e-mails (e eles entrariam
// repetidos na analise) e perderia as sugestoes pendentes.
//
// Rodar DEPOIS do SQL e ANTES do deploy que troca o backend, fora do
// expediente (o relogio do app so confere das 8h as 18h): o que a triagem
// gravar no Redis entre este script e o deploy nao vem junto.
//
// So le o Redis (o robozinho, triagem:modelo, fica la). As chaves antigas
// nao sao apagadas: o "feito" e as encerradas vencem sozinhos em 30 dias, e o
// resto e pequeno.
//
// Uso (na pasta do backend, com KV_* e SUPABASE_* no .env):
//   ENV_FILE=../.env npx tsx scripts/triagem-para-supabase.ts --simular   (so conta, nao grava)
//   ENV_FILE=../.env npx tsx scripts/triagem-para-supabase.ts
import dotenv from "dotenv";
import { Redis } from "@upstash/redis";
import type { BancoDaTriagem } from "../src/services/triagemBanco";

dotenv.config({ path: process.env.ENV_FILE || ".env" });

const TRINTA_DIAS_MS = 30 * 24 * 3600_000;

// O cursor ja foi so o numero (ate 11/11/2026) e depois JSON {janela, vistas}.
export function lerCursorDoRedis(v: unknown): { janela: number; vistas: string[] } {
  let bruto = v;
  if (typeof bruto === "string" && bruto.startsWith("{")) {
    try {
      bruto = JSON.parse(bruto);
    } catch {
      bruto = null;
    }
  }
  if (bruto && typeof bruto === "object") {
    const o = bruto as { janela?: unknown; vistas?: unknown };
    return { janela: Number(o.janela) || 0, vistas: Array.isArray(o.vistas) ? o.vistas.map(String) : [] };
  }
  return { janela: Number(bruto) || 0, vistas: [] };
}

// "triagem:feito:<conta>:<messageId>" -> [conta, messageId]. O e-mail nao tem ":".
function separar(chave: string, prefixo: string): [string, string] | null {
  const resto = chave.slice(prefixo.length);
  const i = resto.indexOf(":");
  return i > 0 ? [resto.slice(0, i), resto.slice(i + 1)] : null;
}

async function main() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Falta KV_REST_API_URL/KV_REST_API_TOKEN no .env.");
  // Sem desserializar: os registros tem que chegar ao Supabase com o texto
  // exato, porque a copia para analise reconhece o que ja tem pelo hash dele.
  const redis = new Redis({ url, token, automaticDeserialization: false });
  const { bancoDaTriagem } = await import("../src/services/triagemBanco");
  const real = bancoDaTriagem();
  const simular = process.argv.includes("--simular");
  // Simulando, tudo que grava vira nada; o que le continua lendo.
  const banco: BancoDaTriagem = simular
    ? new Proxy(real, {
        get: (alvo, nome: keyof BancoDaTriagem) =>
          /^(entrar|gravar|contar|marcar|encerrar|registrar)/.test(String(nome))
            ? async () => true
            : alvo[nome],
      })
    : real;
  if (simular) console.log("SIMULANDO: nada sera gravado no Supabase.");

  // Rodar duas vezes duplicaria os registros e as dispensas. O piloto e o
  // primeiro a ser copiado: se ja tem gente la, a copia ja foi feita.
  if ((await real.listarPiloto()).length && !process.argv.includes("--de-novo")) {
    throw new Error("O Supabase ja tem gente no piloto: a migracao ja rodou. Use --de-novo so se souber o que esta fazendo.");
  }

  const piloto = ((await redis.smembers("triagem:piloto")) || []).map(String);
  for (const c of piloto) await banco.entrarNoPiloto(c);
  console.log(`Piloto: ${piloto.length} conta(s).`);

  // Todas as chaves da triagem, numa varredura so.
  const chaves: string[] = [];
  let cursor = "0";
  do {
    const [proximo, lote] = await redis.scan(cursor, { match: "triagem:*", count: 1000 });
    cursor = String(proximo);
    chaves.push(...lote.map(String));
  } while (cursor !== "0");

  const contas = new Set<string>();
  for (const k of chaves) {
    for (const p of ["triagem:cursor:", "triagem:dispensas:", "triagem:sug:"]) {
      if (k.startsWith(p)) contas.add(k.slice(p.length));
    }
  }
  let sugestoes = 0;
  for (const c of contas) {
    const [cursorBruto, dispensas] = await redis.mget<[string | null, string | null]>(
      `triagem:cursor:${c}`,
      `triagem:dispensas:${c}`,
    );
    const { janela, vistas } = lerCursorDoRedis(cursorBruto);
    if (janela) await banco.gravarCursor(c, janela, vistas);
    // O banco so sabe somar uma e zerar: soma uma a uma (sao poucas).
    for (let i = 0; i < (Number(dispensas) || 0); i++) await banco.contarDispensa(c, false);
    // Sem desserializar, o HGETALL vem cru: [campo, valor, campo, valor...].
    const bruto: unknown = await redis.hgetall(`triagem:sug:${c}`);
    const pares: Array<[string, string]> = [];
    if (Array.isArray(bruto)) {
      for (let i = 0; i + 1 < bruto.length; i += 2) pares.push([String(bruto[i]), String(bruto[i + 1])]);
    } else if (bruto && typeof bruto === "object") {
      for (const [k, v] of Object.entries(bruto)) pares.push([k, typeof v === "string" ? v : JSON.stringify(v)]);
    }
    for (const [threadId, texto] of pares) {
      await banco.gravarSugestao(c, threadId, JSON.parse(texto));
      sugestoes++;
    }
  }
  console.log(`Contas com cursor/dispensas/bandeja: ${contas.size}; sugestoes pendentes: ${sugestoes}.`);

  let feitos = 0;
  let encerradas = 0;
  const vence = new Date(Date.now() + TRINTA_DIAS_MS);
  for (const k of chaves) {
    const feito = k.startsWith("triagem:feito:") && separar(k, "triagem:feito:");
    if (feito) {
      // A validade so serve para a limpeza: 30 dias a partir de hoje basta.
      await banco.marcarFeito(feito[0], feito[1], vence);
      feitos++;
      continue;
    }
    const enc = k.startsWith("triagem:encerrada:") && separar(k, "triagem:encerrada:");
    if (enc) {
      // Aqui a validade e a regra (a conversa nao volta por 30 dias desde o
      // desfecho): leva o que falta de verdade.
      const ms = Number(await redis.pttl(k));
      if (ms > 0) {
        await banco.encerrar(enc[0], enc[1], new Date(Date.now() + ms));
        encerradas++;
      }
    }
  }
  console.log(`E-mails ja triados: ${feitos}; conversas encerradas: ${encerradas}.`);

  // A lista e LPUSH (mais novo no comeco): vai do mais velho para o mais novo,
  // para o id do Supabase ficar na mesma ordem.
  const lista = ((await redis.lrange("triagem:list", 0, -1)) || []).map(String).reverse();
  for (const registro of lista) await banco.registrar(registro);
  console.log(`Registros da analise ainda no Redis: ${lista.length} (copiados na ordem).`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[triagem-para-supabase] ${(e as Error).message}`);
    process.exit(1);
  });
}
