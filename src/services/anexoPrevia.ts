// Previa de anexos que o navegador nao sabe desenhar sozinho.
//
// Imagem, PDF e texto o app exibe direto com os bytes crus (rota /gmail/anexo).
// Planilha e documento do Word precisam ser CONVERTIDOS antes, e e isso que mora
// aqui: a conversao roda no backend para o pacote do desktop — que se
// auto-atualiza na maquina dos usuarios — nao carregar biblioteca nenhuma.

import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { unzipSync } from "fflate";

// Tetos da previa. Existe planilha de 50 mil linhas, e mandar isso para a tela
// travaria o renderer sem ajudar ninguem a decidir se anexa ou nao.
const MAX_LINHAS = 200;
const MAX_COLUNAS = 30;
// Documento escaneado e so imagem. O teto e por RESPOSTA (o base64 infla ~33%),
// para um .docx grande nao virar um JSON de dezenas de MB na tela.
const MAX_IMAGENS = 30;
const MAX_BYTES_IMAGENS = 12 * 1024 * 1024;

export interface ImagemPrevia {
  nome: string;
  mime: string;
  base64: string;
}

export type PreviaAnexo =
  | {
      tipo: "tabela";
      abas: string[];
      aba: string;
      linhas: string[][];
      totalLinhas: number;
      truncado: boolean;
    }
  | {
      tipo: "documento";
      texto: string;
      imagens: ImagemPrevia[];
      imagensOmitidas: number;
    }
  | {
      tipo: "slides";
      slides: { numero: number; linhas: string[] }[];
      imagens: ImagemPrevia[];
      imagensOmitidas: number;
    };

// Que conversao este anexo pede ("" = nenhuma, o app exibe os bytes crus).
// Vai pelo mime e cai na extensao porque anexo de Office as vezes chega como
// application/octet-stream.
export function tipoConversao(
  mime: string,
  nome: string,
): "planilha" | "documento" | "apresentacao" | "" {
  const m = String(mime || "").toLowerCase();
  const ext = String(nome || "")
    .toLowerCase()
    .replace(/^.*\./, "");
  if (m.includes("spreadsheetml") || ext === "xlsx" || ext === "xlsm") {
    return "planilha";
  }
  if (m.includes("wordprocessingml") || ext === "docx") return "documento";
  if (m.includes("presentationml") || ext === "pptx") return "apresentacao";
  return "";
}

// Uma celula pode vir como string, numero, Date, formula, hyperlink ou rich
// text. Sem normalizar, a tabela mostraria "[object Object]" nas tres ultimas.
function textoDaCelula(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toLocaleDateString("pt-BR");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      return o.richText
        .map((p) => String((p as Record<string, unknown>)?.text ?? ""))
        .join("");
    }
    // Formula: o que interessa e o resultado, nao a expressao.
    if ("result" in o) return textoDaCelula(o.result);
    if (typeof o.text === "string") return o.text;
    if ("error" in o) return String(o.error);
    return "";
  }
  return String(v);
}

export async function previaPlanilha(
  bytes: Buffer,
  abaPedida?: string,
): Promise<PreviaAnexo> {
  const wb = new ExcelJS.Workbook();
  // O tipo de load() pede ArrayBuffer; o Buffer do Node atende em runtime.
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);

  const abas = wb.worksheets.map((w) => w.name);
  const ws =
    (abaPedida && wb.worksheets.find((w) => w.name === abaPedida)) ||
    wb.worksheets[0];
  if (!ws) {
    return { tipo: "tabela", abas, aba: "", linhas: [], totalLinhas: 0, truncado: false };
  }

  const linhas: string[][] = [];
  let total = 0;
  ws.eachRow({ includeEmpty: false }, (row) => {
    total += 1;
    if (linhas.length >= MAX_LINHAS) return;
    const celulas: string[] = [];
    // row.values vem com um furo na posicao 0 (o exceljs indexa colunas a
    // partir de 1), por isso o slice.
    const brutas = Array.isArray(row.values) ? row.values.slice(1) : [];
    for (const c of brutas.slice(0, MAX_COLUNAS)) celulas.push(textoDaCelula(c));
    linhas.push(celulas);
  });

  return {
    tipo: "tabela",
    abas,
    aba: ws.name,
    linhas,
    totalLinhas: total,
    truncado: total > linhas.length,
  };
}

// Tipos de imagem que o navegador desenha. .docx tambem carrega EMF/WMF (vetor
// do proprio Office), que nenhum navegador abre — esses entram na contagem de
// omitidas em vez de virar uma imagem quebrada na tela.
const IMG_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
};

// Imagens de dentro do .docx, que e um ZIP com as midias em word/media/.
//
// Por que nao usar o convertToHtml do mammoth, que ja traz as imagens: o HTML
// dele teria que ser sanitizado antes de entrar na tela. Lendo o ZIP direto, a
// tela e montada pelo app com dados que nunca sao interpretados como markup.
function imagensDoZip(
  bytes: Buffer,
  prefixo: string,
): {
  imagens: ImagemPrevia[];
  omitidas: number;
} {
  let arquivos: Record<string, Uint8Array>;
  try {
    arquivos = unzipSync(new Uint8Array(bytes), {
      filter: (f) => f.name.startsWith(prefixo),
    });
  } catch {
    // Arquivo corrompido ou protegido: a previa segue so com o texto.
    return { imagens: [], omitidas: 0 };
  }

  // Ordena pelo numero do nome (image1, image2, ...), que e a ordem em que o
  // Word grava as midias. E aproximado: a ordem real vem das relacoes do
  // document.xml, e ler aquilo so para uma previa nao se paga.
  const nomes = Object.keys(arquivos).sort((a, b) => {
    const n = (s: string) => Number((s.match(/(\d+)\.\w+$/) || [])[1] || 0);
    return n(a) - n(b) || a.localeCompare(b);
  });

  const imagens: ImagemPrevia[] = [];
  let omitidas = 0;
  let acumulado = 0;
  for (const nome of nomes) {
    const ext = nome.toLowerCase().replace(/^.*\./, "");
    const mime = IMG_MIME[ext];
    const dados = arquivos[nome];
    if (!mime || !dados?.length) {
      omitidas += 1;
      continue;
    }
    if (imagens.length >= MAX_IMAGENS || acumulado + dados.length > MAX_BYTES_IMAGENS) {
      omitidas += 1;
      continue;
    }
    acumulado += dados.length;
    imagens.push({
      nome: nome.replace(prefixo, ""),
      mime,
      base64: Buffer.from(dados).toString("base64"),
    });
  }
  return { imagens, omitidas };
}

export async function previaDocumento(bytes: Buffer): Promise<PreviaAnexo> {
  // extractRawText e nao convertToHtml: ver o comentario em imagensDoDocx.
  const { value } = await mammoth.extractRawText({ buffer: bytes });
  // Contrato escaneado nao tem texto NENHUM — so paginas em imagem. Sem estas,
  // a previa dizia "documento sem texto" para um arquivo de 500 KB cheio de
  // conteudo.
  const { imagens, omitidas } = imagensDoZip(bytes, "word/media/");
  return {
    tipo: "documento",
    texto: String(value || "").trim(),
    imagens,
    imagensOmitidas: omitidas,
  };
}

// Tetos da apresentacao, na mesma logica dos outros: deck de 300 slides nao
// ajuda ninguem a decidir se anexa ou nao.
const MAX_SLIDES = 100;
const MAX_LINHAS_SLIDE = 60;

function decodificarXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    // &amp; por ultimo: antes, "&amp;lt;" viraria "<" em vez de "&lt;".
    .replace(/&amp;/g, "&");
}

// Texto de um slide, uma linha por paragrafo.
//
// Le o XML por expressao regular em vez de montar um parser: o OOXML guarda o
// texto em <a:t> dentro de <a:p>, e aqui so EXTRAI — nada do arquivo volta a
// ser interpretado como markup, entao nao ha o risco que justificaria um parser
// completo.
function textoDoSlide(xml: string): string[] {
  const linhas: string[] = [];
  for (const paragrafo of xml.split(/<a:p[\s>]/).slice(1)) {
    const partes = [...paragrafo.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(
      (m) => decodificarXml(m[1]),
    );
    const linha = partes.join("").trim();
    if (linha) linhas.push(linha);
    if (linhas.length >= MAX_LINHAS_SLIDE) break;
  }
  return linhas;
}

export async function previaApresentacao(bytes: Buffer): Promise<PreviaAnexo> {
  let arquivos: Record<string, Uint8Array> = {};
  try {
    arquivos = unzipSync(new Uint8Array(bytes), {
      filter: (f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.name),
    });
  } catch {
    /* corrompido ou protegido: cai no fallback de imagens abaixo */
  }

  // O ZIP nao devolve os slides em ordem (medido: slide2, slide3, slide4,
  // slide1...), entao ordenar pelo numero do nome nao e detalhe.
  const nomes = Object.keys(arquivos).sort((a, b) => {
    const n = (s: string) => Number((s.match(/slide(\d+)\.xml$/) || [])[1] || 0);
    return n(a) - n(b);
  });

  const slides = nomes.slice(0, MAX_SLIDES).map((nome) => ({
    numero: Number((nome.match(/slide(\d+)\.xml$/) || [])[1] || 0),
    linhas: textoDoSlide(Buffer.from(arquivos[nome]).toString("utf-8")),
  }));

  // Deck inteiro sem texto = slides em imagem (o mesmo caso do contrato
  // escaneado). So entao as midias valem a pena; num deck de texto elas seriam
  // o logo repetido.
  const semTexto = slides.every((s) => !s.linhas.length);
  const { imagens, omitidas } = semTexto
    ? imagensDoZip(bytes, "ppt/media/")
    : { imagens: [], omitidas: 0 };

  return { tipo: "slides", slides, imagens, imagensOmitidas: omitidas };
}
