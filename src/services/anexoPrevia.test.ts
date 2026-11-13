import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import {
  miniaturaDaPrevia,
  miniaturaDeTexto,
  previaDocumentoFormatada,
  tipoVisualizacao,
  type PreviaAnexo,
} from "./anexoPrevia";

// PNG de 1x1 e um .docx minimo com texto, imagem, texto e uma imagem EMF (que
// navegador nenhum abre), nessa ordem.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
function docxComImagens(): Buffer {
  const imagem = (rid: string) =>
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Imagem"/>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="img"/><pic:cNvPicPr/></pic:nvPicPr>' +
    `<pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const par = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
          '<Default Extension="emf" ContentType="image/x-emf"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      "word/_rels/document.xml.rels": strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
          '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.emf"/></Relationships>',
      ),
      "word/document.xml": strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
          'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>' +
          par("Passo 1: acesse o portal") +
          imagem("rId5") +
          par("Passo 2: clique em Configurações") +
          imagem("rId6") +
          "</w:body></w:document>",
      ),
      "word/media/image1.png": new Uint8Array(PNG_1X1),
      "word/media/image2.emf": new Uint8Array([1, 2, 3, 4]),
    }),
  );
}

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

test("Word formatado: imagem no lugar dela, EMF contada como omitida", async () => {
  const p = await previaDocumentoFormatada(docxComImagens());
  assert.equal(p.tipo, "documento");
  if (p.tipo !== "documento") return;
  const html = p.html || "";
  const passo1 = html.indexOf("Passo 1");
  const img = html.indexOf('src="data:image/png;base64,');
  const passo2 = html.indexOf("Passo 2");
  assert.ok(passo1 >= 0 && img > passo1 && passo2 > img, html);
  assert.equal(p.imagensOmitidas, 1); // a EMF
  assert.deepEqual(p.imagens, []); // nada solto no fim
});

test("miniatura de texto decodifica Latin-1 e corta", () => {
  const latin1 = Buffer.from("Endereço da empresa\n".repeat(100), "latin1");
  const m = miniaturaDeTexto(latin1);
  assert.equal(m.tipo, "texto");
  if (m.tipo !== "texto") return;
  assert.ok(m.texto.startsWith("Endereço da empresa"));
  assert.equal(m.texto.length, 600);
});
