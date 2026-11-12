import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { BancoDaTriagem, UsoDaTriagem } from "./triagemBanco";
import { usarBancoDeTeste } from "./triagemBanco";

// O painel de custos soma o gasto do Redis (uso:*) com o da triagem, que mora
// no Supabase desde 12/11/2026. O Redis responde por um fetch falso, no
// formato do Upstash (base64); o Supabase e trocado por um banco de mentira.
process.env.KV_REST_API_URL = "https://redis.teste";
process.env.KV_REST_API_TOKEN = "teste";

const hashes = new Map<string, Record<string, string>>();
const listas = new Map<string, string[]>();
const b64 = (s: string) => Buffer.from(s).toString("base64");
const enc = (v: unknown): unknown =>
  typeof v === "string" ? b64(v) : Array.isArray(v) ? v.map(enc) : v;

function redis([nome, chave, ...a]: string[]): unknown {
  switch (nome.toLowerCase()) {
    case "smembers":
      return chave === "uso:dias" ? ["2026-11-11"] : [];
    case "hgetall":
      return Object.entries(hashes.get(chave) || {}).flat();
    case "lpush": {
      const l = listas.get(chave) || [];
      l.unshift(...a);
      listas.set(chave, l);
      return l.length;
    }
    default:
      return "OK";
  }
}

const json = (corpo: unknown) =>
  new Response(JSON.stringify(corpo), { status: 200, headers: { "Content-Type": "application/json" } });

let usos: UsoDaTriagem[] = [];
let falhar = false;
const bancoDeMentira = {
  async lerUso() {
    if (falhar) throw new Error("Supabase respondeu 503 em GET triagem_uso: fora do ar");
    return usos;
  },
} as unknown as BancoDaTriagem;

beforeEach(() => {
  hashes.clear();
  listas.clear();
  falhar = false;
  usarBancoDeTeste(bancoDeMentira);
  globalThis.fetch = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = String(entrada);
    const corpo = JSON.parse(String(init?.body));
    if (url.endsWith("/pipeline")) return json((corpo as string[][]).map((c) => ({ result: enc(redis(c)) })));
    return json({ result: enc(redis(corpo)) });
  }) as typeof fetch;
  // Dia 11 no Redis: um resumo de chat e a triagem de antes da mudanca.
  hashes.set("uso:d:2026-11-11", {
    "claude-haiku-5-5::resumo::in": "1000",
    "claude-haiku-5-5::resumo::out": "100",
    "claude-haiku-5-5::resumo::calls": "2",
  });
  hashes.set("uso:df:2026-11-11", {
    "triagem::claude-haiku-5-5::resumo::in": "400",
    "triagem::claude-haiku-5-5::resumo::out": "40",
    "triagem::claude-haiku-5-5::resumo::calls": "1",
  });
  // No Supabase: mais triagem no dia 11 (depois da mudanca) e o dia 12 inteiro.
  usos = [
    { dia: "2026-11-11", modelo: "claude-haiku-5-5", op: "resumo", inputTokens: 300, outputTokens: 30, chamadas: 1 },
    { dia: "2026-11-12", modelo: "claude-haiku-5-5", op: "resumo", inputTokens: 500, outputTokens: 50, chamadas: 2 },
  ];
});

test("soma o gasto da triagem do Supabase com o do Redis, sem duplicar linha", async () => {
  const { getRelatorioUso } = await import("./usage");
  const r = await getRelatorioUso();
  assert.deepEqual(
    r.porDia.map((d) => [d.dia, d.inputTokens, d.calls]),
    [
      ["2026-11-11", 1300, 3],
      ["2026-11-12", 500, 2],
    ],
  );
  assert.deepEqual(r.linhas.map((l) => [l.model, l.op, l.inputTokens, l.outputTokens, l.calls]), [
    ["claude-haiku-5-5", "resumo", 1800, 180, 5],
  ]);
  assert.equal(r.porDiaModelo.length, 2, "uma linha por dia+modelo+op");
  assert.deepEqual(
    r.porFonte.filter((f) => f.fonte === "triagem").map((f) => [f.dia, f.inputTokens, f.calls]),
    [
      ["2026-11-11", 700, 2],
      ["2026-11-12", 500, 2],
    ],
  );
  assert.equal(r.porRamal.length, 0, "a triagem nao tem ramal");
});

test("Supabase fora do ar: o painel sai com o Redis e o erro vai para o /admin/erros", async () => {
  falhar = true;
  const { getRelatorioUso } = await import("./usage");
  const r = await getRelatorioUso();
  assert.deepEqual(r.porDia.map((d) => [d.dia, d.inputTokens]), [["2026-11-11", 1000]]);
  const erros = (listas.get("erros:list") || []).map((l) => JSON.parse(l));
  assert.equal(erros.length, 1);
  assert.match(erros[0].mensagem, /gasto da triagem fora do painel de custos: .*503/);
});
