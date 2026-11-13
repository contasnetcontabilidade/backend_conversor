import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compararVersoes,
  diaLocal,
  juntarPessoas,
  oQueGravar,
  pcValido,
  REGRAVAR_MS,
  versaoDoReleases,
  versaoDoUserAgent,
  versaoValida,
} from "./appOnline";

// O que o Electron manda nas chamadas feitas pela tela do app.
const UA_APP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "conversor-wav-txt-desktop/1.9.4 Chrome/146.0.7680.65 Electron/41.2.0 Safari/537.36";
const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/146.0.7680.65 Safari/537.36";

// 12/11/2026 14:00 em Sao Paulo (17:00 UTC).
const AGORA = Date.UTC(2026, 10, 12, 17, 0, 0);
const HORA = 3_600_000;

test("versao sai do User-Agent do app, e de mais nada", () => {
  assert.equal(versaoDoUserAgent(UA_APP), "1.9.4");
  assert.equal(versaoDoUserAgent(UA_CHROME), ""); // navegador comum
  assert.equal(versaoDoUserAgent("node"), ""); // processo principal do app
  assert.equal(versaoDoUserAgent(undefined), "");
});

test("comparacao de versao e numerica, nao de texto", () => {
  assert.ok(compararVersoes("1.9.10", "1.9.4") > 0);
  assert.ok(compararVersoes("1.8.10", "1.9.2") < 0);
  assert.equal(compararVersoes("1.9.4", "1.9.4"), 0);
});

test("versao publicada = a maior do RELEASES (com BOM e delta)", () => {
  const texto =
    "﻿AAA conversor_wav_txt_desktop-1.9.3-full.nupkg 1\r\n" +
    "BBB conversor_wav_txt_desktop-1.9.4-delta.nupkg 2\r\n" +
    "CCC conversor_wav_txt_desktop-1.9.4-full.nupkg 3";
  assert.equal(versaoDoReleases(texto), "1.9.4");
  assert.equal(versaoDoReleases("<html>nao achado</html>"), "");
});

test("dia e o de Sao Paulo, nao o UTC", () => {
  // 23h de 12/11 em Sao Paulo ja e 13/11 em UTC.
  assert.equal(diaLocal(Date.UTC(2026, 10, 13, 2, 0, 0)), "2026-11-12");
});

test("grava na 1a vez, depois so com versao nova ou passada 1 hora", () => {
  const primeira = oQueGravar(undefined, "1.9.4", "", AGORA);
  assert.deepEqual(primeira, { visto: true, abriu: true, dia: "2026-11-12" });

  const antes = { v: "1.9.4", s: "", t: AGORA, dia: "2026-11-12" };
  assert.deepEqual(oQueGravar(antes, "1.9.4", "", AGORA + 10 * 60_000), {
    visto: false,
    abriu: false,
    dia: "2026-11-12",
  });
  assert.equal(oQueGravar(antes, "1.9.4", "", AGORA + REGRAVAR_MS).visto, true);
  assert.equal(oQueGravar(antes, "1.9.5", "", AGORA + 60_000).visto, true);
  assert.equal(oQueGravar(antes, "1.9.4", "Fiscal", AGORA + 60_000).visto, true);
  // Virou o dia: o "abriu" do dia novo vai mesmo dentro da hora.
  const ontem = { ...antes, dia: "2026-11-11" };
  assert.equal(oQueGravar(ontem, "1.9.4", "", AGORA + 60_000).abriu, true);
  // Trocou de maquina: grava na hora. Mesmo PC dentro da hora, nao.
  const comPc = { ...antes, pc: "PC-FISCAL-03" };
  assert.equal(oQueGravar(comPc, "1.9.4", "", AGORA + 60_000, "PC-FISCAL-03").visto, false);
  assert.equal(oQueGravar(comPc, "1.9.4", "", AGORA + 60_000, "PC-SUPORTE-01").visto, true);
});

// Vem do pedido de token do Ably e vai para o Redis e para o HTML do painel.
test("versao e PC mandados pelo app so passam no formato esperado", () => {
  assert.equal(versaoValida("1.9.5"), "1.9.5");
  assert.equal(versaoValida(" 1.10.0 "), "1.10.0");
  assert.equal(versaoValida("1.9"), "");
  assert.equal(versaoValida("1.9.5<script>"), "");
  assert.equal(versaoValida(undefined), "");
  assert.equal(pcValido("PC-FISCAL-03"), "PC-FISCAL-03");
  assert.equal(pcValido('PC"><img src=x>'), "PCimgsrcx");
  assert.equal(pcValido("x".repeat(60)).length, 40);
});

test("registro do app (a:) e o da tela (r:) do mesmo ramal viram uma linha", () => {
  const pessoas = juntarPessoas({
    conectados: new Map([["410", 1]]),
    vistos: {
      // A tela anotou depois, mas sem setor nem PC: os do app continuam.
      "a:410": { v: "1.9.5", t: AGORA - HORA, s: "Pessoal", pc: "PC-DP-07" },
      "r:410": { v: "1.9.5", t: AGORA - 10 * 60_000 },
      // Conta com setor antigo, de antes da troca no perfil.
      "c:dani@contas.com.br": { v: "1.9.4", t: AGORA - 5 * HORA, r: "410", s: "Fiscal" },
    },
    abriu: { "a:410": AGORA - 2 * HORA },
    nomes: { "410": "Dani" },
    agora: AGORA,
  });
  assert.equal(pessoas.length, 1);
  const dani = pessoas[0];
  assert.equal(dani.versao, "1.9.5");
  assert.equal(dani.setor, "Pessoal"); // o mais recente, nao o da conta
  assert.equal(dani.pc, "PC-DP-07");
  assert.equal(dani.abriuEm, AGORA - 2 * HORA);
  assert.deepEqual(dani.contas, ["dani@contas.com.br"]);
});

test("junta Ably, registro do ramal e registro da conta numa linha so", () => {
  const pessoas = juntarPessoas({
    conectados: new Map([
      ["201", 2],
      ["258", 1],
    ]),
    vistos: {
      "r:201": JSON.stringify({ v: "1.9.3", t: AGORA - 3 * HORA }),
      // A conferencia das Sugestoes e mais recente: a versao dela vale.
      "c:carla@contas.com.br": { v: "1.9.4", t: AGORA - HORA, r: "201", s: "Fiscal" },
      "r:303": { v: "1.9.4", t: AGORA - 2 * HORA }, // fora agora, usou hoje
      "r:330": { v: "1.9.2", t: AGORA - 30 * HORA }, // visto ontem
      "c:semvinculo@contas.com.br": { v: "1.9.4", t: AGORA - HORA }, // sem ramal
      "r:lixo": "nao e json",
    },
    abriu: {
      "r:201": AGORA - 6 * HORA,
      "c:carla@contas.com.br": AGORA - 5 * HORA,
    },
    nomes: { "201": "Carla Mendes", "303": "João Carvalho" },
    agora: AGORA,
  });
  const por = (k: string) => pessoas.find((p) => (p.ramal || p.contas[0]) === k)!;

  const carla = por("201");
  assert.equal(carla.status, "online");
  assert.equal(carla.maquinas, 2);
  assert.equal(carla.nome, "Carla Mendes");
  assert.equal(carla.versao, "1.9.4");
  assert.equal(carla.setor, "Fiscal");
  assert.deepEqual(carla.contas, ["carla@contas.com.br"]);
  assert.equal(carla.abriuEm, AGORA - 6 * HORA); // a primeira das duas

  const teste = por("258"); // online sem nenhuma versao anotada ainda
  assert.equal(teste.status, "online");
  assert.equal(teste.versao, "");
  assert.equal(teste.nome, "Ramal 258");

  assert.equal(por("303").status, "saiu");
  assert.equal(por("330").status, "offline");

  const semVinculo = por("semvinculo@contas.com.br");
  assert.equal(semVinculo.ramal, "");
  assert.equal(semVinculo.nome, "semvinculo");
  assert.equal(semVinculo.status, "saiu");

  assert.equal(pessoas.length, 5); // o registro invalido fica de fora
});
