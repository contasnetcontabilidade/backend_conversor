import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Ponta a ponta do piloto sem tocar em nada real: Redis (Upstash), Gmail e
// Claude respondem por um fetch falso. O Redis falso guarda o estado em
// memoria e responde no formato do Upstash (base64, como o cliente pede).
process.env.KV_REST_API_URL = "https://redis.teste";
process.env.KV_REST_API_TOKEN = "teste";
process.env.ANTHROPIC_API_KEY = "teste";

const CONTA = "atendente@contas.com.br";
const DIA = 86_400_000;

type Valor = string | Map<string, string> | Set<string> | string[];
const db = new Map<string, Valor>();
let chamadasIa = 0;
let threads: Record<string, Array<{ id: string; de: string; quando: number; assunto: string; corpo: string; enviada?: boolean }>> = {};

const b64 = (s: string) => Buffer.from(s).toString("base64");
const b64url = (s: string) => Buffer.from(s).toString("base64url");
function enc(v: unknown): unknown {
  if (typeof v === "string") return b64(v);
  if (Array.isArray(v)) return v.map(enc);
  return v;
}

function redis(cmd: string[]): unknown {
  const [nome, chave, ...a] = cmd.map(String);
  const op = nome.toLowerCase();
  const hash = () => (db.get(chave) as Map<string, string>) || new Map<string, string>();
  const conj = () => (db.get(chave) as Set<string>) || new Set<string>();
  switch (op) {
    case "get":
      return typeof db.get(chave) === "string" ? db.get(chave) : null;
    case "set": {
      const nx = a.some((x) => x.toLowerCase() === "nx");
      if (nx && db.has(chave)) return null;
      db.set(chave, a[0]);
      return "OK";
    }
    case "del":
      return db.delete(chave) ? 1 : 0;
    case "expire":
      return 1;
    case "incr": {
      const n = (Number(db.get(chave)) || 0) + 1;
      db.set(chave, String(n));
      return n;
    }
    case "sismember":
      return conj().has(a[0]) ? 1 : 0;
    case "sadd": {
      const s = conj();
      a.forEach((x) => s.add(x));
      db.set(chave, s);
      return a.length;
    }
    case "srem": {
      const s = conj();
      return a.filter((x) => s.delete(x)).length;
    }
    case "smembers":
      return [...conj()];
    case "hset": {
      const h = hash();
      for (let i = 0; i < a.length; i += 2) h.set(a[i], a[i + 1]);
      db.set(chave, h);
      return a.length / 2;
    }
    case "hgetall":
      return [...hash().entries()].flat();
    case "hdel": {
      const h = hash();
      const n = a.filter((f) => h.delete(f)).length;
      return n;
    }
    case "hincrby": {
      const h = hash();
      h.set(a[0], String((Number(h.get(a[0])) || 0) + Number(a[1])));
      db.set(chave, h);
      return Number(h.get(a[0]));
    }
    case "lpush": {
      const l = (db.get(chave) as string[]) || [];
      l.unshift(...a);
      db.set(chave, l);
      return l.length;
    }
    case "ltrim":
      return "OK";
    default:
      return null;
  }
}

function gmailThread(id: string) {
  const msgs = threads[id];
  if (!msgs) return null;
  return {
    id,
    messages: msgs.map((m) => ({
      id: m.id,
      threadId: id,
      internalDate: String(m.quando),
      labelIds: m.enviada ? ["SENT"] : ["INBOX", "CATEGORY_PERSONAL"],
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: m.de },
          { name: "Subject", value: m.assunto },
        ],
        body: { data: b64url(m.corpo) },
      },
    })),
  };
}

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

before(() => {
  globalThis.fetch = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = String(entrada instanceof Request ? entrada.url : entrada);
    if (url.startsWith("https://redis.teste")) {
      const corpo = JSON.parse(String(init?.body));
      // O cliente junta comandos sozinho (auto-pipeline) e manda em /pipeline.
      if (url.endsWith("/pipeline")) {
        return json((corpo as string[][]).map((cmd) => ({ result: enc(redis(cmd)) })));
      }
      return json({ result: enc(redis(corpo)) });
    }
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/threads?")) {
      return json({ threads: Object.keys(threads).map((id) => ({ id })) });
    }
    const t = /\/threads\/([^?]+)\?format=full/.exec(url);
    if (t) {
      const corpo = gmailThread(decodeURIComponent(t[1]));
      return corpo ? json(corpo) : json({ error: { code: 404 } }, 404);
    }
    if (url.startsWith("https://api.anthropic.com/v1/messages")) {
      chamadasIa++;
      const prompt = JSON.stringify(JSON.parse(String(init?.body)).messages);
      const pedido = prompt.includes("PEDIDO");
      return json({
        id: "msg_teste",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              categoria: pedido ? "pedido_cliente" : "aviso_automatico",
              motivo: pedido ? "Cliente pede ferias." : "Aviso automatico.",
              decisao: pedido ? "sim" : "nao",
              confianca: 0.9,
            }),
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1500, output_tokens: 70 },
      });
    }
    // Conferencia diaria do preco no site (precoClaude.ts): fora do teste.
    return new Response("", { status: 404 });
  }) as typeof fetch;
});

beforeEach(() => {
  db.clear();
  chamadasIa = 0;
  db.set(`gmail:access:${CONTA}`, "token-de-teste");
  const agora = Date.now();
  threads = {
    t1: [{ id: "m1", de: "Cliente <c@empresa.com.br>", quando: agora - 3600_000, assunto: "Ferias", corpo: "PEDIDO: ferias do funcionario a partir de 15/12, por favor." }],
    t2: [{ id: "m2", de: "Banco <nao-responda@banco.com.br>", quando: agora - 1800_000, assunto: "Boleto", corpo: "Seu boleto foi emitido." }],
    t3: [{ id: "m3", de: `Eu <${CONTA}>`, quando: agora - 600_000, assunto: "Envio", corpo: "Segue o arquivo.", enviada: true }],
  };
});

async function piloto() {
  return import("./triagemPiloto");
}

test("fora do piloto a conta nao entra; entrar e sair mudam na hora", async () => {
  const p = await piloto();
  assert.equal(await p.estaNoPiloto(CONTA), false);
  await p.entrarNoPiloto(CONTA.toUpperCase());
  assert.equal(await p.estaNoPiloto(CONTA), true);
  assert.deepEqual(await p.listarPiloto(), [CONTA]);
  await p.sairDoPiloto(CONTA);
  assert.equal(await p.estaNoPiloto(CONTA), false);
});

test("conferencia sugere o pedido, registra tudo e paga a IA uma vez so", async () => {
  const p = await piloto();
  const r = await p.conferirCaixa(CONTA, { setor: "Suporte" });
  // t3 so tem mensagem enviada pela propria pessoa: nao ha gatilho, nao gasta IA.
  assert.equal(chamadasIa, 2);
  assert.equal(r.triadas, 2);
  assert.equal(r.novas, 1);
  assert.equal(r.pendentes, 0);
  assert.deepEqual(
    r.sugestoes.map((s) => [s.threadId, s.assunto, s.deEmail]),
    [["t1", "Ferias", "c@empresa.com.br"]],
  );
  const lista = (db.get(p.KEY_LISTA) as string[]).map((l) => JSON.parse(l));
  assert.equal(lista.length, 2);
  assert.ok(lista.every((l) => l.tipo === "triagem" && l.trecho && l.versaoPrompt));
  assert.equal(lista.find((l) => l.threadId === "t1").sugerida, true);
  assert.equal(lista.find((l) => l.threadId === "t2").sugerida, false);
  assert.ok(Number(db.get(`triagem:cursor:${CONTA}`)) > 0, "cursor anda quando tudo foi visto");
  assert.equal(db.has(`triagem:trava:${CONTA}`), false, "trava liberada");

  // Gasto: um registro so, na fonte "triagem" e sem ramal.
  const dia = new Date().toISOString().slice(0, 10);
  const porFonte = db.get(`uso:df:${dia}`) as Map<string, string>;
  assert.equal(porFonte.get("triagem::claude-haiku-5-5::resumo::in"), "3000");
  assert.equal(porFonte.get("triagem::claude-haiku-5-5::resumo::calls"), "1");
  assert.equal(db.has(`uso:du:${dia}`), false, "sem ramal: fora do 'IA sem chamado'");

  // Segunda conferencia: nada novo na caixa, nada pago de novo.
  const r2 = await p.conferirCaixa(CONTA, { setor: "Suporte" });
  assert.equal(chamadasIa, 2);
  assert.equal(r2.triadas, 0);
  assert.equal(r2.sugestoes.length, 1);
});

test("'nao e chamado' tira a sugestao e vira rotulo; sem sugestao nao anota nada", async () => {
  const p = await piloto();
  await p.conferirCaixa(CONTA);
  assert.equal(await p.registrarDesfecho(CONTA, "t1", "nao_e_chamado", "aviso_automatico"), true);
  assert.deepEqual(await p.listarSugestoes(CONTA), []);
  assert.equal(await p.registrarDesfecho(CONTA, "t1", "virou_chamado"), false);
  const desfechos = (db.get(p.KEY_LISTA) as string[])
    .map((l) => JSON.parse(l))
    .filter((l) => l.tipo === "desfecho");
  assert.deepEqual(
    desfechos.map((d) => [d.threadId, d.desfecho, d.motivo]),
    [["t1", "nao_e_chamado", "aviso_automatico"]],
  );
});

test("'nao e para mim' e 'ja virou chamado' tem desfecho proprio, fora do negativo do aprendizado", async () => {
  const p = await piloto();
  assert.equal(p.desfechoDoMotivo("nao_e_para_mim"), "nao_e_para_mim");
  assert.equal(p.desfechoDoMotivo("ja_virou_chamado"), "ja_era_chamado");
  assert.equal(p.desfechoDoMotivo("aviso_automatico"), "nao_e_chamado");
  assert.equal(p.desfechoDoMotivo("inventado"), null);
  assert.equal(p.MOTIVOS_PARA_O_APP[0].rotulo, "Não é para mim");
  assert.ok(p.MOTIVOS_PARA_O_APP.every((m) => !("desfecho" in m)), "o app nao recebe o desfecho");

  await p.conferirCaixa(CONTA);
  await p.registrarDesfecho(CONTA, "t1", p.desfechoDoMotivo("nao_e_para_mim")!, "nao_e_para_mim");
  const ultima = JSON.parse((db.get(p.KEY_LISTA) as string[])[0]);
  assert.deepEqual([ultima.desfecho, ultima.motivo], ["nao_e_para_mim", "nao_e_para_mim"]);
});

test("sugestao sem acao por mais de 7 dias sai como 'ignorada'", async () => {
  const p = await piloto();
  await p.conferirCaixa(CONTA);
  const h = db.get(`triagem:sug:${CONTA}`) as Map<string, string>;
  const s = JSON.parse(h.get("t1") as string);
  h.set("t1", JSON.stringify({ ...s, sugeridaEm: Date.now() - 8 * DIA }));
  assert.deepEqual(await p.listarSugestoes(CONTA), []);
  const ultima = JSON.parse((db.get(p.KEY_LISTA) as string[])[0]);
  assert.deepEqual([ultima.tipo, ultima.threadId, ultima.desfecho], ["desfecho", "t1", "ignorada"]);
});

test("mais de 10 conversas: a proxima conferencia continua de onde parou e so entao o cursor anda", async () => {
  const p = await piloto();
  const agora = Date.now();
  threads = {};
  for (let i = 1; i <= 12; i++) {
    threads[`n${i}`] = [{ id: `nm${i}`, de: "Banco <aviso@banco.com.br>", quando: agora - i * 60_000, assunto: `Aviso ${i}`, corpo: "Seu boleto foi emitido." }];
  }
  const r1 = await p.conferirCaixa(CONTA);
  assert.equal(r1.triadas, 10);
  assert.equal(r1.pendentes, 2);
  const cursor1 = Number(db.get(`triagem:cursor:${CONTA}`));
  assert.ok(cursor1 > 0 && cursor1 < agora - 23 * 3600_000, "janela fixa comecando ~24 h atras");
  assert.equal((db.get(`triagem:vistas:${CONTA}`) as Set<string>).size, 10);

  const r2 = await p.conferirCaixa(CONTA);
  assert.equal(r2.triadas, 2, "triou so as 2 que faltavam");
  assert.equal(r2.pendentes, 0);
  assert.equal(chamadasIa, 12, "cada e-mail pago uma vez so");
  assert.ok(Number(db.get(`triagem:cursor:${CONTA}`)) > cursor1, "janela vista inteira: cursor andou");
  assert.equal(db.has(`triagem:vistas:${CONTA}`), false, "anotacao das vistas apagada");
});

const responder = (threadId: string, corpo = "Resolvido, pode testar.") =>
  threads[threadId].push({ id: `${threadId}-resp`, de: `Eu <${CONTA}>`, quando: Date.now() + 1000, assunto: "Re:", corpo, enviada: true });

test("resposta numa sugestao da bandeja marca 'respondeu' sem pagar a IA de novo", async () => {
  const p = await piloto();
  await p.conferirCaixa(CONTA);
  assert.equal((await p.listarSugestoes(CONTA))[0].respondeu, undefined);
  responder("t1");
  const r = await p.conferirCaixa(CONTA);
  assert.equal(chamadasIa, 2, "so as triagens da primeira conferencia");
  const s = r.sugestoes.find((x) => x.threadId === "t1")!;
  assert.equal(s.respondeu, true);
  assert.ok(s.respondidaEm! > s.quando);
  const ultima = JSON.parse((db.get(p.KEY_LISTA) as string[])[0]);
  assert.deepEqual([ultima.tipo, ultima.threadId], ["resposta", "t1"]);
});

test("resposta numa conversa que a chegada nao sugeriu: tria com a resposta e ja nasce respondida", async () => {
  const p = await piloto();
  threads.t4 = [{ id: "m4", de: "Colega <colega@contas.com.br>", quando: Date.now() - 1800_000, assunto: "Sistema", corpo: "O sistema esta lento hoje." }];
  await p.conferirCaixa(CONTA);
  assert.equal(chamadasIa, 3);
  assert.equal((await p.listarSugestoes(CONTA)).some((s) => s.threadId === "t4"), false);
  responder("t4", "PEDIDO atendido: reiniciei o servico e liberei o acesso.");
  const r = await p.conferirCaixa(CONTA);
  assert.equal(chamadasIa, 4, "uma triagem nova, a da resposta");
  const s = r.sugestoes.find((x) => x.threadId === "t4")!;
  assert.equal(s.respondeu, true);
  assert.equal(s.messageId, "m4", "aponta para o e-mail recebido");
  assert.equal(r.sugestoes[0].threadId, "t4", "respondidas vem primeiro");
});

test("conversa encerrada ('nao e chamado') nao volta, nem com resposta nova", async () => {
  const p = await piloto();
  await p.conferirCaixa(CONTA);
  await p.registrarDesfecho(CONTA, "t1", "nao_e_chamado", "outro");
  responder("t1", "PEDIDO? nao, era so um aviso.");
  const r = await p.conferirCaixa(CONTA);
  assert.equal(chamadasIa, 2);
  assert.deepEqual(r.sugestoes, []);
});

test("aprende com quem dispensa: 5 'nao e chamado' sobem o limiar; 'nao e para mim' nao conta; virar chamado desce", async () => {
  const p = await piloto();
  const semear = (id: string) => {
    const h = (db.get(`triagem:sug:${CONTA}`) as Map<string, string>) || new Map<string, string>();
    h.set(id, JSON.stringify({ threadId: id, messageId: id, assunto: "x", deNome: "", deEmail: "a@b.com", quando: Date.now(), motivo: "", categoria: "outro", confianca: 0.8, sugeridaEm: Date.now() }));
    db.set(`triagem:sug:${CONTA}`, h);
  };
  assert.equal(await p.limiarDaPessoa(CONTA), p.LIMIAR_PADRAO);
  for (let i = 1; i <= 4; i++) {
    semear(`d${i}`);
    await p.registrarDesfecho(CONTA, `d${i}`, "nao_e_chamado", "aviso_automatico");
  }
  semear("d5");
  await p.registrarDesfecho(CONTA, "d5", "nao_e_para_mim", "nao_e_para_mim");
  assert.equal(await p.limiarDaPessoa(CONTA), p.LIMIAR_PADRAO, "4 dispensas + 'nao e para mim' ainda nao sobe");
  semear("d6");
  await p.registrarDesfecho(CONTA, "d6", "nao_e_chamado", "outro");
  assert.equal(await p.limiarDaPessoa(CONTA), p.LIMIAR_QUEM_DISPENSA);
  semear("d7");
  await p.registrarDesfecho(CONTA, "d7", "virou_chamado");
  assert.equal(await p.limiarDaPessoa(CONTA), p.LIMIAR_PADRAO, "abriu chamado de uma sugestao: volta");
});

test("com outra conferencia em andamento, so devolve a lista (sem ler a caixa)", async () => {
  const p = await piloto();
  db.set(`triagem:trava:${CONTA}`, "1");
  const r = await p.conferirCaixa(CONTA);
  assert.equal(r.conferidoEm, null);
  assert.equal(chamadasIa, 0);
  assert.equal(db.get(`triagem:trava:${CONTA}`), "1", "nao solta a trava dos outros");
});
