// O "robozinho" da triagem mora no Redis (triagem:modelo), nao no codigo: o
// repositorio e publico. Este script sobe, mostra ou tira o modelo. Vale na
// conferencia seguinte (cache de ate 10 min em cada instancia da Vercel).
//
// Uso (na pasta do backend):
//   ENV_FILE=../.env npx tsx scripts/triagem-modelo.ts ver
//   ENV_FILE=../.env npx tsx scripts/triagem-modelo.ts subir <modelo.json>
//   ENV_FILE=../.env npx tsx scripts/triagem-modelo.ts tirar     (desliga o filtro)
//
// O modelo.json sai do treino em Python (ml/exportar.py do repositorio copia-analise, em Desktop/Database) e fica na
// pasta de dados da Fase 0 (Desktop\Database\data\fase0, tambem fora do git).
import dotenv from "dotenv";
import { readFileSync } from "fs";
import { Redis } from "@upstash/redis";

dotenv.config({ path: process.env.ENV_FILE || ".env" });

async function main() {
  const [acao, arquivo] = process.argv.slice(2);
  const { KEY_MODELO, modeloValido } = await import("../src/services/triagemModelo");
  const r = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "",
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "",
  });
  if (acao === "subir") {
    if (!arquivo) throw new Error("Informe o arquivo do modelo.");
    const modelo = JSON.parse(readFileSync(arquivo, "utf8"));
    if (!modeloValido(modelo)) throw new Error("Arquivo nao e um modelo valido (versao, corte, intercepto, palavras, meta).");
    await r.set(KEY_MODELO, JSON.stringify(modelo));
  } else if (acao === "tirar") {
    await r.del(KEY_MODELO);
    console.log("Modelo tirado: a triagem volta a mandar tudo para a IA.");
    return;
  } else if (acao !== "ver") {
    throw new Error("Use: ver | subir <modelo.json> | tirar");
  }
  const atual = await r.get<Record<string, unknown>>(KEY_MODELO);
  if (!atual) {
    console.log("Sem modelo no Redis: filtro desligado.");
    return;
  }
  const palavras = Object.keys((atual.palavras as object) || {}).length;
  console.log(
    `Modelo no ar: versao ${atual.versao} | corte ${atual.corte} | ${palavras} palavras | treinado com ${atual.treinadoCom ?? "?"} e-mails`,
  );
}

main().catch((e) => {
  console.error(`[triagem-modelo] ${(e as Error).message}`);
  process.exit(1);
});
