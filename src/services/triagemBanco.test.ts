import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { criarBancoSupabase } from "./triagemBanco";

// O que o cliente manda para a API REST do Supabase (PostgREST). O
// comportamento do banco (o insert que nao entra, a soma do gasto) esta no
// supabase/triagem.sql; aqui confere que cada chamada pede a coisa certa.

interface Pedido {
  metodo: string;
  url: URL;
  cabecalhos: Record<string, string>;
  corpo: unknown;
}
let pedidos: Pedido[] = [];
let respostas: Array<{ status: number; corpo?: unknown }> = [];

beforeEach(() => {
  pedidos = [];
  respostas = [];
  globalThis.fetch = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const cabecalhos = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) || {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    pedidos.push({
      metodo: init?.method || "GET",
      url: new URL(String(entrada)),
      cabecalhos,
      corpo: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = respostas.shift() || { status: 200, corpo: [] };
    return new Response(r.corpo === undefined ? "" : JSON.stringify(r.corpo), { status: r.status });
  }) as typeof fetch;
});

const CONTA = "fulano+teste@contas.com.br";
const banco = () => criarBancoSupabase("https://abc.supabase.co/", "sb_secret_teste");

test("chave nova (sb_secret_) vai so no apikey; a antiga (JWT) tambem no Authorization", async () => {
  await banco().listarPiloto();
  assert.equal(pedidos[0].cabecalhos.apikey, "sb_secret_teste");
  assert.equal(pedidos[0].cabecalhos.authorization, undefined);
  await criarBancoSupabase("https://abc.supabase.co", "eyJ.jwt.antigo").listarPiloto();
  assert.equal(pedidos[1].cabecalhos.authorization, "Bearer eyJ.jwt.antigo");
  assert.equal(pedidos[1].url.href, "https://abc.supabase.co/rest/v1/triagem_piloto?select=conta&order=conta");
});

test("o e-mail vai codificado no filtro (o + nao vira espaco)", async () => {
  respostas.push({ status: 200, corpo: [{ conta: CONTA }] });
  assert.equal(await banco().estaNoPiloto(CONTA), true);
  assert.equal(pedidos[0].url.searchParams.get("conta"), `eq.${CONTA}`);
  assert.equal(await banco().estaNoPiloto(CONTA), false, "lista vazia = fora");
});

test("marcarFeito: insert que ignora repetido e devolve so o que entrou", async () => {
  respostas.push({ status: 201, corpo: [{ message_id: "m1" }] }, { status: 201, corpo: [] });
  const expira = new Date("2026-12-12T00:00:00.000Z");
  assert.equal(await banco().marcarFeito(CONTA, "m1", expira), true);
  assert.equal(await banco().marcarFeito(CONTA, "m1", expira), false);
  const p = pedidos[0];
  assert.equal(p.metodo, "POST");
  assert.equal(p.url.pathname, "/rest/v1/triagem_feito");
  assert.equal(p.url.searchParams.get("on_conflict"), "conta,message_id");
  assert.equal(p.cabecalhos.prefer, "resolution=ignore-duplicates,return=representation");
  assert.deepEqual(p.corpo, { conta: CONTA, message_id: "m1", expira_em: "2026-12-12T00:00:00.000Z" });
});

test("cursor: upsert que so troca janela e vistas (as dispensas ficam)", async () => {
  await banco().gravarCursor(CONTA, 123, ["t1", "t2"]);
  const p = pedidos[0];
  assert.equal(p.url.searchParams.get("on_conflict"), "conta");
  assert.equal(p.cabecalhos.prefer, "resolution=merge-duplicates,return=minimal");
  const corpo = p.corpo as Record<string, unknown>;
  assert.deepEqual([corpo.conta, corpo.janela_ms, corpo.vistas], [CONTA, 123, ["t1", "t2"]]);
  assert.equal("dispensas" in corpo, false);
});

test("lerConta: conta sem linha = nova (janela 0, sem dispensas)", async () => {
  assert.deepEqual(await banco().lerConta(CONTA), { janela: 0, vistas: [], dispensas: 0 });
  respostas.push({ status: 200, corpo: [{ janela_ms: 1700000000000, vistas: ["t9"], dispensas: 5 }] });
  assert.deepEqual(await banco().lerConta(CONTA), { janela: 1700000000000, vistas: ["t9"], dispensas: 5 });
});

test("tirarSugestao: DELETE que devolve o que apagou", async () => {
  respostas.push({ status: 200, corpo: [{ thread_id: "t1" }] }, { status: 200, corpo: [] });
  assert.equal(await banco().tirarSugestao(CONTA, "t1"), true);
  assert.equal(await banco().tirarSugestao(CONTA, "t1"), false);
  assert.equal(pedidos[0].metodo, "DELETE");
  assert.equal(pedidos[0].url.searchParams.get("thread_id"), "eq.t1");
  assert.equal(pedidos[0].cabecalhos.prefer, "return=representation");
});

test("gasto e dispensa vao pelas funcoes do banco (somar sem perder conferencia simultanea)", async () => {
  await banco().somarUso({ dia: "2026-11-12", modelo: "claude-haiku-5-5", op: "resumo", inputTokens: 10, outputTokens: 2 });
  await banco().contarDispensa(CONTA, false);
  assert.equal(pedidos[0].url.pathname, "/rest/v1/rpc/triagem_somar_uso");
  assert.deepEqual(pedidos[0].corpo, { p_dia: "2026-11-12", p_modelo: "claude-haiku-5-5", p_op: "resumo", p_in: 10, p_out: 2 });
  assert.equal(pedidos[1].url.pathname, "/rest/v1/rpc/triagem_dispensa");
  assert.deepEqual(pedidos[1].corpo, { p_conta: CONTA, p_zerar: false });
});

test("o registro vai como texto, do jeito que veio", async () => {
  const texto = '{"ts":"2026-11-12T10:00:00.000Z","tipo":"triagem"}';
  await banco().registrar(texto);
  assert.deepEqual(pedidos[0].corpo, { registro: texto });
});

test("erro do Supabase vira excecao com o status, sem o e-mail da URL", async () => {
  respostas.push({ status: 401, corpo: { message: "Invalid API key" } });
  await assert.rejects(banco().estaNoPiloto(CONTA), (e: Error) => {
    assert.match(e.message, /401 em GET triagem_piloto: .*Invalid API key/);
    assert.equal(e.message.includes(CONTA), false);
    return true;
  });
});
