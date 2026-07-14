import { AsyncLocalStorage } from "node:async_hooks";

// Contexto por requisicao para escolher o ambiente do Suite360/SuiteWeb.
// O middleware le o header `x-suite-env: dev` e roda o handler dentro deste
// contexto; os leitores de config em suite360.ts consultam isSuiteDev() para
// decidir entre as variaveis de PROD e as `*_DEV`.

type SuiteCtx = { dev: boolean };

const als = new AsyncLocalStorage<SuiteCtx>();

export function runWithSuiteEnv<T>(dev: boolean, fn: () => T): T {
  return als.run({ dev }, fn);
}

export function isSuiteDev(): boolean {
  return als.getStore()?.dev === true;
}
