import { test } from "node:test";
import assert from "node:assert/strict";
import {
  miniaturaDaPrevia,
  miniaturaDeTexto,
  tipoVisualizacao,
  type PreviaAnexo,
} from "./anexoPrevia";

// Tem que bater com o revTipoAnexo do app: e o que decide qual rota a tela
// chama para cada anexo da conversa.
test("tipo de visualizacao de cada anexo do Chat", () => {
  assert.equal(tipoVisualizacao("image/png", "print.png"), "imagem");
  assert.equal(tipoVisualizacao("image/svg+xml", "logo.svg"), ""); // pode ter script
  assert.equal(tipoVisualizacao("application/pdf", "guia.pdf"), "pdf");
  assert.equal(tipoVisualizacao("application/octet-stream", "guia.PDF"), "pdf");
  assert.equal(tipoVisualizacao("video/mp4", "video.mp4"), "video");
  assert.equal(tipoVisualizacao("text/plain", "folha.csv"), "planilha"); // CSV antes do text/
  assert.equal(
    tipoVisualizacao("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx"),
    "planilha",
  );
  assert.equal(tipoVisualizacao("application/octet-stream", "contrato.docx"), "word");
  assert.equal(tipoVisualizacao("application/octet-stream", "deck.pptx"), "slides");
  assert.equal(tipoVisualizacao("application/xml", "nfe.xml"), "texto");
  assert.equal(tipoVisualizacao("text/plain", "log.txt"), "texto");
  assert.equal(tipoVisualizacao("application/zip", "arquivos.zip"), "");
});

test("miniatura da planilha: so o canto de cima, com celula curta", () => {
  const linhas = Array.from({ length: 50 }, (_, i) =>
    Array.from({ length: 10 }, (_, j) => (i === 0 && j === 0 ? "x".repeat(90) : `${i}-${j}`)),
  );
  const previa: PreviaAnexo = {
    tipo: "tabela",
    abas: ["Folha", "Resumo"],
    aba: "Folha",
    linhas,
    totalLinhas: 1200,
    truncado: true,
  };
  const m = miniaturaDaPrevia(previa);
  assert.equal(m.tipo, "tabela");
  if (m.tipo !== "tabela") return;
  assert.equal(m.linhas.length, 6);
  assert.equal(m.linhas[0].length, 5);
  assert.equal(m.linhas[0][0].length, 40);
  assert.equal(m.totalLinhas, 1200);
  assert.equal(m.abas, 2);
});

test("miniatura do Word: texto; imagem so quando o documento nao tem texto", () => {
  const pequena = { nome: "p.png", mime: "image/png", base64: "A".repeat(1000) };
  const grande = { nome: "g.png", mime: "image/png", base64: "A".repeat(500_000) };
  const comTexto = miniaturaDaPrevia({
    tipo: "documento",
    texto: "Contrato ".repeat(200),
    imagens: [pequena],
    imagensOmitidas: 0,
  });
  assert.equal(comTexto.tipo, "documento");
  if (comTexto.tipo !== "documento") return;
  assert.equal(comTexto.texto.length, 600);
  assert.equal(comTexto.imagem, undefined); // seria o logo do cabecalho

  // Escaneado: pula a imagem grande demais e leva a primeira pequena.
  const escaneado = miniaturaDaPrevia({
    tipo: "documento",
    texto: "",
    imagens: [grande, pequena],
    imagensOmitidas: 0,
  });
  assert.equal(escaneado.tipo === "documento" && escaneado.imagem?.nome, "p.png");
});

test("miniatura do PowerPoint: primeiro slide com texto", () => {
  const m = miniaturaDaPrevia({
    tipo: "slides",
    slides: [
      { numero: 1, linhas: [] },
      { numero: 2, linhas: ["Fechamento de outubro", "a", "b", "c", "d", "e", "f"] },
    ],
    imagens: [],
    imagensOmitidas: 0,
  });
  assert.deepEqual(m, {
    tipo: "slides",
    total: 2,
    linhas: ["Fechamento de outubro", "a", "b", "c", "d", "e"],
  });
});

test("miniatura de texto decodifica Latin-1 e corta", () => {
  const latin1 = Buffer.from("Endereço da empresa\n".repeat(100), "latin1");
  const m = miniaturaDeTexto(latin1);
  assert.equal(m.tipo, "texto");
  if (m.tipo !== "texto") return;
  assert.ok(m.texto.startsWith("Endereço da empresa"));
  assert.equal(m.texto.length, 600);
});
