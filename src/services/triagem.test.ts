import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gatilhosDaThread,
  limparCorpo,
  montarPromptTriagem,
  montarTrecho,
  paraTriagem,
  SEPARADOR_RESPOSTA,
  TRECHO_CHEGADA,
  TRECHO_DA_RESPOSTA,
  TRECHO_RECEBIDO_NA_RESPOSTA,
  type MensagemTriagem,
} from "./triagem";

const DIA = 86_400_000;
const DESDE = Date.UTC(2026, 6, 21);

function msg(id: string, dias: number, daConta: boolean, corpo = "texto"): MensagemTriagem {
  return {
    id,
    quando: DESDE + dias * DIA,
    fromNome: daConta ? "Atendente" : "Cliente",
    fromEmail: daConta ? "atendente@contas.com.br" : "cliente@empresa.com.br",
    daConta,
    corpo,
  };
}

test("chegada e o primeiro recebido no periodo; resposta e a primeira da pessoa depois de um recebido", () => {
  const g = gatilhosDaThread([msg("r2", 2, true), msg("c1", 1, false), msg("c3", 3, false)], DESDE);
  assert.deepEqual(
    g.map((x) => [x.tipo, x.messageId, x.recebida.id]),
    [
      ["chegada", "c1", "c1"],
      ["resposta", "r2", "c1"],
    ],
  );
});

test("conversa comecada pela propria pessoa nao tem gatilho de resposta ate alguem responder", () => {
  const g = gatilhosDaThread([msg("e1", 1, true), msg("c2", 2, false), msg("e3", 3, true)], DESDE);
  assert.deepEqual(
    g.map((x) => [x.tipo, x.messageId, x.recebida.id]),
    [
      ["chegada", "c2", "c2"],
      ["resposta", "e3", "c2"],
    ],
  );
});

test("mensagens antes do periodo nao disparam, mas contam como o recebido que a pessoa respondeu", () => {
  const g = gatilhosDaThread([msg("c0", -5, false), msg("r1", 1, true)], DESDE);
  assert.deepEqual(
    g.map((x) => [x.tipo, x.messageId, x.recebida.id]),
    [["resposta", "r1", "c0"]],
  );
});

test("SENT ou o proprio endereco marcam a mensagem como da conta", () => {
  const base = { id: "x", quando: 1, fromNome: "", subject: "", corpo: "" };
  assert.equal(paraTriagem({ ...base, fromEmail: "a@b.com", labelIds: ["SENT"] }, "eu@contas.com.br").daConta, true);
  assert.equal(paraTriagem({ ...base, fromEmail: "eu@contas.com.br", labelIds: [] }, "Eu@Contas.com.br").daConta, true);
  assert.equal(paraTriagem({ ...base, fromEmail: "a@b.com", labelIds: ["INBOX"] }, "eu@contas.com.br").daConta, false);
});

test("limparCorpo corta a citacao da mensagem anterior e troca links", () => {
  const corpo =
    "Bom dia, preciso das ferias do funcionario a partir de 15/12, segue o pedido.\r\nVeja https://exemplo.com/a?b=1\r\n\r\n" +
    "Em seg., 10 de nov. de 2026 as 09:00, Fulano <f@x.com> escreveu:\r\n> pedido antigo";
  assert.equal(
    limparCorpo(corpo),
    "Bom dia, preciso das ferias do funcionario a partir de 15/12, segue o pedido.\nVeja [link]",
  );
});

test("texto novo curto ('segue abaixo') mantem a parte citada, onde esta o pedido", () => {
  const corpo =
    "Segue abaixo.\n\nEm ter., 4 de nov. de 2026, Cliente <c@x.com> escreveu:\n> Preciso da guia do FGTS de outubro.";
  assert.match(limparCorpo(corpo), /Preciso da guia do FGTS/);
});

test("trecho respeita os limites de chegada e de resposta", () => {
  const longo = "palavra ".repeat(300);
  const [chegada, resposta] = gatilhosDaThread([msg("c1", 1, false, longo), msg("r2", 2, true, longo)], DESDE);
  assert.equal(montarTrecho(chegada).length, TRECHO_CHEGADA);
  const [rec, resp] = montarTrecho(resposta).split(SEPARADOR_RESPOSTA);
  assert.equal(rec.length, TRECHO_RECEBIDO_NA_RESPOSTA);
  assert.equal(resp.length, TRECHO_DA_RESPOSTA);
});

test("prompt traz setor, remetente, momento e o trecho entre aspas", () => {
  const [chegada, resposta] = gatilhosDaThread([msg("c1", 1, false), msg("r2", 2, true)], DESDE);
  const p1 = montarPromptTriagem({ setor: "Departamento Pessoal", assunto: "Ferias", gatilho: chegada, trecho: "TRECHO-X" });
  assert.match(p1, /\(setor: Departamento Pessoal\)/);
  assert.match(p1, /De: Cliente <cliente@empresa\.com\.br>/);
  assert.match(p1, /ACABOU DE CHEGAR/);
  assert.match(p1, /"""\nTRECHO-X\n"""/);
  const p2 = montarPromptTriagem({ assunto: "", gatilho: resposta, trecho: "" });
  assert.match(p2, /JA RESPONDEU/);
  assert.match(p2, /Assunto: \(sem assunto\)/);
  assert.match(p2, /\(sem texto: so anexo ou imagem\)/);
  assert.doesNotMatch(p2, /setor:/);
});
