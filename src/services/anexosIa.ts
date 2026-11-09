import type Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import { getErrorMessage } from "../lib/errors";
import {
  previaApresentacao,
  previaCsv,
  previaDocumento,
  previaPlanilha,
  textoDoCsv,
  tipoConversao,
  type PreviaAnexo,
} from "./anexoPrevia";

// Anexos de e-mail e de mensagem do Chat no formato que a IA do resumo le
// (decidido em 09/11/2026: ler tudo, automatico, com teto). Antes a IA so
// recebia o texto, e o prompt mandava tratar anexo como "enviou print do erro".
//
// - imagem (print, foto) e PDF vao como ARQUIVO: o Claude Haiku 5.5 e o Gemini
//   de reserva leem os dois direto, inclusive PDF escaneado;
// - Word, Excel, CSV e PowerPoint viram texto pelas mesmas conversoes da
//   previa do app (anexoPrevia.ts);
// - .txt, .xml (nota fiscal) e .ofx (extrato) entram como texto;
// - o resto (video, audio, compactado) nao e lido: vai so o nome, e o prompt
//   trata como "so o fato".
//
// Os tetos existem por causa do preco: acima de 100 mil tokens de entrada a
// chamada INTEIRA do Haiku sai 5x mais cara (claude.ts), e o prompt com a lista
// de assuntos ja ocupa uma parte disso. Por isso os anexos tem um orcamento
// proprio, ESTIMADO antes de mandar (a contagem exata so viria com mais uma
// chamada a API).

// Estimativas por cima (melhor sobrar orcamento que estourar a faixa de preco):
// imagem grande e reduzida pela API para ~1,15 MP, ~1.600 tokens; pagina de
// PDF vai como texto + imagem da pagina, 1.500 a 3.000 tokens.
const TOKENS_POR_IMAGEM = 1_600;
const TOKENS_POR_PAGINA_PDF = 3_000;
const CARACTERES_POR_TOKEN = 3;
const ORCAMENTO_TOKENS = 60_000;

const MAX_ANEXOS_LIDOS = 10;
const MAX_PAGINAS_PDF = 10; // guia e boleto tem 1 ou 2; o resto e cortado
const MAX_CARACTERES_TEXTO = 15_000; // por anexo
const MAX_ABAS_PLANILHA = 3;
// A API da Anthropic recusa imagem acima de 5 MB em base64 (= 3,75 MB crus).
// Uma imagem recusada derruba a chamada inteira, entao o corte e aqui.
const MAX_BYTES_IMAGEM = 3_750_000;
// O pedido inteiro tem teto de 32 MB na API; o base64 infla 33%.
const MAX_BYTES_TOTAL = 18 * 1024 * 1024;
// Arquivo maior que isso nem e baixado (e o mesmo teto do Suite).
const MAX_BYTES_ARQUIVO = 20 * 1024 * 1024;
const PRAZO_DOWNLOAD_MS = 15_000;
const DOWNLOADS_SIMULTANEOS = 3;

export interface AnexoParaIa {
  nome: string;
  mime: string;
  tamanho?: number; // bytes, quando a fonte informa (o Gmail informa; o Chat nao)
  baixar: () => Promise<Buffer>;
}

type MimeImagem = "image/png" | "image/jpeg" | "image/webp";

export type ParteAnexoIa =
  | { tipo: "imagem"; nome: string; mime: MimeImagem; base64: string; bytes: number }
  | {
      tipo: "pdf";
      nome: string;
      base64: string;
      bytes: number;
      paginas: number;
      paginasTotal: number;
    }
  | { tipo: "texto"; nome: string; texto: string; cortado: boolean };

export interface AnexosIa {
  partes: ParteAnexoIa[];
  naoLidos: Array<{ nome: string; motivo: string }>;
  tokensEstimados: number;
}

type Tipo = "imagem" | "pdf" | "office" | "texto";

function extensao(nome: string): string {
  const n = String(nome || "").toLowerCase();
  return n.includes(".") ? n.replace(/^.*\./, "") : "";
}

// Pelo mime e, quando ele vem generico (octet-stream), pela extensao. O tipo
// REAL da imagem e conferido depois nos bytes (mimeDaImagem).
function classificar(a: AnexoParaIa): Tipo | "" {
  const m = String(a.mime || "").toLowerCase();
  const ext = extensao(a.nome);
  if (/^image\/(png|jpe?g|webp)$/.test(m) || ["png", "jpg", "jpeg", "webp"].includes(ext)) {
    return "imagem";
  }
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (tipoConversao(a.mime, a.nome)) return "office";
  if (
    m === "text/plain" ||
    m === "text/xml" ||
    m === "application/xml" ||
    ["txt", "xml", "ofx"].includes(ext)
  ) {
    return "texto";
  }
  return "";
}

function motivoNaoLido(a: AnexoParaIa): string {
  const m = String(a.mime || "").toLowerCase();
  const ext = extensao(a.nome);
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (["zip", "rar", "7z"].includes(ext) || /zip|rar|7z|compressed/.test(m)) {
    return "arquivo compactado";
  }
  return "formato que a IA nao le";
}

// O mime declarado pode mentir (print salvo como .png que e JPEG). A API
// recusa imagem com tipo errado — e a recusa derruba o resumo inteiro.
function mimeDaImagem(b: Buffer): MimeImagem | "" {
  if (b.length > 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") {
    return "image/png";
  }
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    b.length > 12 &&
    b.toString("latin1", 0, 4) === "RIFF" &&
    b.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return "";
}

function cortarTexto(texto: string): { texto: string; cortado: boolean } {
  const limpo = texto.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (limpo.length <= MAX_CARACTERES_TEXTO) return { texto: limpo, cortado: false };
  return { texto: limpo.slice(0, MAX_CARACTERES_TEXTO), cortado: true };
}

function tabelaComoTexto(previa: PreviaAnexo): string {
  if (previa.tipo !== "tabela") return "";
  const cabeca =
    previa.abas.length > 1 || previa.aba
      ? `Aba "${previa.aba}" (${previa.totalLinhas} linha(s)${
          previa.truncado ? `, so as ${previa.linhas.length} primeiras` : ""
        }):`
      : "";
  const linhas = previa.linhas.map((l) => l.join(" | ")).join("\n");
  return [cabeca, linhas].filter(Boolean).join("\n");
}

async function textoDoOffice(nome: string, mime: string, bytes: Buffer): Promise<string> {
  const conversao = tipoConversao(mime, nome);
  if (conversao === "csv") return tabelaComoTexto(await previaCsv(bytes));
  if (conversao === "planilha") {
    const primeira = await previaPlanilha(bytes);
    if (primeira.tipo !== "tabela") return "";
    const blocos = [tabelaComoTexto(primeira)];
    for (const aba of primeira.abas.filter((a) => a !== primeira.aba).slice(0, MAX_ABAS_PLANILHA - 1)) {
      blocos.push(tabelaComoTexto(await previaPlanilha(bytes, aba)));
    }
    return blocos.filter(Boolean).join("\n\n");
  }
  if (conversao === "apresentacao") {
    const previa = await previaApresentacao(bytes);
    if (previa.tipo !== "slides") return "";
    return previa.slides
      .map((s) => `Slide ${s.numero}: ${s.linhas.join(" / ")}`)
      .join("\n");
  }
  const previa = await previaDocumento(bytes);
  return previa.tipo === "documento" ? previa.texto : "";
}

// PDF longo: so as primeiras paginas (e o que cabe no orcamento; em guia,
// boleto e nota o que importa esta no comeco). PDF com senha a API nao le.
async function prepararPdf(
  nome: string,
  bytes: Buffer,
): Promise<ParteAnexoIa> {
  if (bytes.toString("latin1", 0, 5) !== "%PDF-") throw new Error("nao e um PDF valido");
  let doc: PDFDocument;
  let paginasTotal: number;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
    // PDF quebrado abre sem erro e so falha aqui, ao procurar as paginas.
    paginasTotal = doc.getPageCount();
  } catch (error) {
    const msg = getErrorMessage(error);
    throw new Error(/encrypt/i.test(msg) ? "PDF protegido por senha" : "PDF ilegivel");
  }
  if (paginasTotal < 1) throw new Error("PDF ilegivel");
  if (paginasTotal <= MAX_PAGINAS_PDF) {
    return {
      tipo: "pdf",
      nome,
      base64: bytes.toString("base64"),
      bytes: bytes.length,
      paginas: paginasTotal,
      paginasTotal,
    };
  }
  const recorte = await PDFDocument.create();
  const copiadas = await recorte.copyPages(
    doc,
    Array.from({ length: MAX_PAGINAS_PDF }, (_, i) => i),
  );
  copiadas.forEach((p) => recorte.addPage(p));
  const menor = Buffer.from(await recorte.save());
  return {
    tipo: "pdf",
    nome,
    base64: menor.toString("base64"),
    bytes: menor.length,
    paginas: MAX_PAGINAS_PDF,
    paginasTotal,
  };
}

async function converter(
  a: AnexoParaIa,
  tipo: Tipo,
  bytes: Buffer,
): Promise<ParteAnexoIa> {
  if (tipo === "imagem") {
    const mime = mimeDaImagem(bytes);
    if (!mime) throw new Error("imagem em formato que a IA nao le");
    if (bytes.length > MAX_BYTES_IMAGEM) throw new Error("imagem grande demais");
    return { tipo: "imagem", nome: a.nome, mime, base64: bytes.toString("base64"), bytes: bytes.length };
  }
  if (tipo === "pdf") return prepararPdf(a.nome, bytes);
  const bruto = tipo === "office" ? await textoDoOffice(a.nome, a.mime, bytes) : textoDoCsv(bytes);
  if (!bruto.trim()) throw new Error("sem texto para ler");
  return { tipo: "texto", nome: a.nome, ...cortarTexto(bruto) };
}

function estimarTokens(p: ParteAnexoIa): number {
  if (p.tipo === "imagem") return TOKENS_POR_IMAGEM;
  if (p.tipo === "pdf") return p.paginas * TOKENS_POR_PAGINA_PDF;
  return Math.ceil(p.texto.length / CARACTERES_POR_TOKEN);
}

function comPrazo<T>(tarefa: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const estouro = new Promise<never>((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new Error("download demorou demais")), ms);
  });
  return Promise.race([tarefa, estouro]).finally(() => clearTimeout(timer));
}

async function emLotes<E, R>(
  itens: E[],
  simultaneos: number,
  fn: (item: E) => Promise<R>,
): Promise<R[]> {
  const saida: R[] = new Array(itens.length);
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < itens.length) {
      const i = proximo++;
      saida[i] = await fn(itens[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(simultaneos, itens.length) }, trabalhador));
  return saida;
}

// Nunca lanca: anexo que falha vira "nao lido" com o motivo, e o resumo segue
// com o resto. O motivo vai para o log (sem conteudo do arquivo).
export async function prepararAnexosIa(anexos: AnexoParaIa[]): Promise<AnexosIa> {
  const naoLidos: AnexosIa["naoLidos"] = [];
  const fila: Array<{ a: AnexoParaIa; tipo: Tipo }> = [];
  for (const a of anexos) {
    const tipo = classificar(a);
    if (!tipo) naoLidos.push({ nome: a.nome, motivo: motivoNaoLido(a) });
    else if ((a.tamanho || 0) > MAX_BYTES_ARQUIVO) naoLidos.push({ nome: a.nome, motivo: "grande demais" });
    else if (fila.length >= MAX_ANEXOS_LIDOS) naoLidos.push({ nome: a.nome, motivo: "acima do limite de anexos lidos" });
    else fila.push({ a, tipo });
  }

  const convertidos = await emLotes(fila, DOWNLOADS_SIMULTANEOS, async ({ a, tipo }) => {
    try {
      const bytes = await comPrazo(a.baixar(), PRAZO_DOWNLOAD_MS);
      if (bytes.length > MAX_BYTES_ARQUIVO) throw new Error("grande demais");
      return { a, parte: await converter(a, tipo, bytes) };
    } catch (error) {
      const motivo = getErrorMessage(error);
      console.warn(`[anexos-ia] "${a.nome}" nao lido: ${motivo}`);
      return { a, motivo };
    }
  });

  // Orcamento na ORDEM em que os anexos vieram: o primeiro costuma ser o
  // principal ("segue a guia"), e o que vem depois e o que sobra.
  const partes: ParteAnexoIa[] = [];
  let tokens = 0;
  let bytesTotal = 0;
  for (const c of convertidos) {
    if (!("parte" in c) || !c.parte) {
      naoLidos.push({ nome: c.a.nome, motivo: c.motivo || "falhou" });
      continue;
    }
    const custo = estimarTokens(c.parte);
    const peso = c.parte.tipo === "texto" ? 0 : c.parte.bytes;
    if (tokens + custo > ORCAMENTO_TOKENS || bytesTotal + peso > MAX_BYTES_TOTAL) {
      naoLidos.push({ nome: c.a.nome, motivo: "acima do limite de leitura" });
      continue;
    }
    tokens += custo;
    bytesTotal += peso;
    partes.push(c.parte);
  }
  return { partes, naoLidos, tokensEstimados: tokens };
}

// Linha de log, sem conteudo: so contagem e tipo.
export function descreverAnexosIa(r: AnexosIa): string {
  const conta = (t: ParteAnexoIa["tipo"]) => r.partes.filter((p) => p.tipo === t).length;
  return (
    `${r.partes.length} lido(s) (${conta("imagem")} imagem, ${conta("pdf")} pdf, ` +
    `${conta("texto")} texto; ~${r.tokensEstimados} tokens), ${r.naoLidos.length} nao lido(s)`
  );
}

// O que os previews de e-mail e Chat chamam. Nao derruba o preview: um erro
// inesperado aqui vira resumo sem anexos (logado), como era antes.
export async function lerAnexosParaIa(
  anexos: AnexoParaIa[],
  contexto: string,
): Promise<AnexosIa> {
  if (!anexos.length) return { partes: [], naoLidos: [], tokensEstimados: 0 };
  try {
    const r = await prepararAnexosIa(anexos);
    console.info(`[anexos-ia] ${contexto}: ${descreverAnexosIa(r)}`);
    return r;
  } catch (error) {
    console.warn(
      `[anexos-ia] ${contexto}: falhou, resumo segue sem anexos: ${getErrorMessage(error)}`,
    );
    return {
      partes: [],
      naoLidos: anexos.map((a) => ({ nome: a.nome, motivo: "nao lido" })),
      tokensEstimados: 0,
    };
  }
}

// Cabecalho de cada anexo no pedido a IA. O prompt (bloco ANEXOS) se refere a
// ele como "ANEXO n: nome".
export function rotuloAnexoIa(p: ParteAnexoIa, i: number): string {
  const extra =
    p.tipo === "pdf" && p.paginas < p.paginasTotal
      ? ` (primeiras ${p.paginas} de ${p.paginasTotal} paginas)`
      : p.tipo === "texto" && p.cortado
        ? " (texto cortado no limite de leitura)"
        : "";
  return `ANEXO ${i + 1}: ${p.nome}${extra}`;
}

export function blocosClaude(partes: ParteAnexoIa[]): Anthropic.ContentBlockParam[] {
  return partes.flatMap((p, i): Anthropic.ContentBlockParam[] => {
    const rotulo = rotuloAnexoIa(p, i);
    if (p.tipo === "texto") return [{ type: "text", text: `${rotulo}\n${p.texto}` }];
    if (p.tipo === "imagem") {
      return [
        { type: "text", text: rotulo },
        { type: "image", source: { type: "base64", media_type: p.mime, data: p.base64 } },
      ];
    }
    return [
      { type: "text", text: rotulo },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: p.base64 } },
    ];
  });
}

export type ParteGemini = { text: string } | { inlineData: { mimeType: string; data: string } };

export function partesGemini(partes: ParteAnexoIa[]): ParteGemini[] {
  return partes.flatMap((p, i): ParteGemini[] => {
    const rotulo = rotuloAnexoIa(p, i);
    if (p.tipo === "texto") return [{ text: `${rotulo}\n${p.texto}` }];
    const mimeType = p.tipo === "imagem" ? p.mime : "application/pdf";
    return [{ text: rotulo }, { inlineData: { mimeType, data: p.base64 } }];
  });
}
