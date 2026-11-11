import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizar, notaDoModelo, termos, type ModeloTriagem } from "./triagemModelo";

// Modelo e textos INVENTADOS (nada de e-mail real): o scikit-learn treinou este
// modelo de brinquedo e calculou as notas esperadas (scratchpad/ml-filtro/
// exportar.py). O teste garante que a conta do backend e a mesma do Python:
// se a limpeza do texto ou o TF-IDF divergirem, o filtro erra sem dar erro.
const MODELO: ModeloTriagem = {
  "versao": "teste",
  "corte": 0.02,
  "intercepto": 0.23801191965268886,
  "palavras": {
    "bom": [
      1.8472978603872037,
      0.5464229882877678
    ],
    "bom dia": [
      1.8472978603872037,
      0.5464229882877678
    ],
    "dia": [
      1.8472978603872037,
      0.5464229882877678
    ],
    "por": [
      1.8472978603872037,
      0.6166275921662752
    ],
    "por gentileza": [
      1.8472978603872037,
      0.6166275921662752
    ],
    "gentileza": [
      1.8472978603872037,
      0.6166275921662752
    ],
    "senha": [
      2.252762968495368,
      0.4679386139333586
    ],
    "obrigado": [
      2.252762968495368,
      -0.4934517383354126
    ],
    "recebido": [
      2.252762968495368,
      -0.4934517383354126
    ],
    "nao": [
      2.252762968495368,
      -0.31090374025336054
    ],
    "nao responda": [
      2.252762968495368,
      -0.31090374025336054
    ],
    "responda": [
      2.252762968495368,
      -0.31090374025336054
    ],
    "boleto": [
      2.252762968495368,
      -0.31090374025336054
    ],
    "solicito": [
      2.252762968495368,
      0.19841925912304448
    ],
    "rescisao": [
      2.252762968495368,
      0.19841925912304448
    ],
    "evento": [
      2.252762968495368,
      -0.6218074805067211
    ],
    "procuracao": [
      2.252762968495368,
      0.28403313614136017
    ]
  },
  "meta": {
    "category_promotions": -0.6218074805067211,
    "category_updates": -0.6218074805067211,
    "colega": -0.2044722943470011,
    "externo": 0.20402980551539163,
    "gat_chegada": -0.8915106248471576,
    "gat_resposta": 0.8910681360155484
  }
};

const CASOS = [
  {
    "texto": "Bom dia bom dia! Por gentileza, a SENHA não funciona",
    "remetenteDominio": "cliente.com.br",
    "gatilho": "chegada",
    "abas": [],
    "esperado": 0.6925937885388178
  },
  {
    "texto": "Obrigado, recebido.",
    "remetenteDominio": "contas.com.br",
    "gatilho": "chegada",
    "abas": [],
    "esperado": 0.17424767974298525
  },
  {
    "texto": "Não responda — boleto emitido",
    "remetenteDominio": "cliente.com.br",
    "gatilho": "chegada",
    "abas": [
      "CATEGORY_UPDATES"
    ],
    "esperado": 0.1553707128232758
  },
  {
    "texto": "Palavras que o modelo nunca viu",
    "remetenteDominio": "cliente.com.br",
    "gatilho": "chegada",
    "abas": [],
    "esperado": 0.38948704732807593
  },
  {
    "texto": "",
    "remetenteDominio": "contas.com.br",
    "gatilho": "resposta",
    "abas": [],
    "esperado": 0.7159800378090465
  }
];

test("a nota do backend e a mesma do scikit-learn (texto com acento, maiuscula, pontuacao, vazio)", () => {
  for (const c of CASOS) {
    const nota = notaDoModelo(MODELO, { assunto: c.texto, trecho: "", remetenteDominio: c.remetenteDominio, gatilho: c.gatilho, abas: c.abas });
    assert.ok(Math.abs(nota - c.esperado) < 1e-9, `${JSON.stringify(c.texto)}: ${nota} != ${c.esperado}`);
  }
});

test("limpeza igual a do scikit-learn: minuscula, sem acento, palavras de 2+ letras e pares", () => {
  assert.equal(normalizar("NÃO Responda — Ação"), "nao responda — acao");
  assert.deepEqual(termos("Bom dia, a SENHA!"), ["bom", "dia", "senha", "bom dia", "dia senha"]);
});

test("palavra com nome interno de objeto (constructor) nao vira NaN", () => {
  const nota = notaDoModelo(MODELO, { assunto: "constructor toString __proto__", trecho: "", remetenteDominio: "x.com", gatilho: "chegada", abas: [] });
  assert.ok(Number.isFinite(nota));
});
