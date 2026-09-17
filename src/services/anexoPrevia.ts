// Previa de anexos que o navegador nao sabe desenhar sozinho.
//
// Imagem, PDF e texto o app exibe direto com os bytes crus (rota /gmail/anexo).
// Planilha e documento do Word precisam ser CONVERTIDOS antes, e e isso que mora
// aqui: a conversao roda no backend para o pacote do desktop — que se
// auto-atualiza na maquina dos usuarios — nao carregar biblioteca nenhuma.

import ExcelJS from "exceljs";
import mammoth from "mammoth";

// Tetos da previa. Existe planilha de 50 mil linhas, e mandar isso para a tela
// travaria o renderer sem ajudar ninguem a decidir se anexa ou nao.
const MAX_LINHAS = 200;
const MAX_COLUNAS = 30;

export type PreviaAnexo =
  | {
      tipo: "tabela";
      abas: string[];
      aba: string;
      linhas: string[][];
      totalLinhas: number;
      truncado: boolean;
    }
  | { tipo: "texto"; texto: string };

// Que conversao este anexo pede ("" = nenhuma, o app exibe os bytes crus).
// Vai pelo mime e cai na extensao porque anexo de Office as vezes chega como
// application/octet-stream.
export function tipoConversao(
  mime: string,
  nome: string,
): "planilha" | "documento" | "" {
  const m = String(mime || "").toLowerCase();
  const ext = String(nome || "")
    .toLowerCase()
    .replace(/^.*\./, "");
  if (m.includes("spreadsheetml") || ext === "xlsx" || ext === "xlsm") {
    return "planilha";
  }
  if (m.includes("wordprocessingml") || ext === "docx") return "documento";
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

export async function previaDocumento(bytes: Buffer): Promise<PreviaAnexo> {
  // extractRawText e nao convertToHtml de proposito: o HTML do mammoth teria
  // que ser sanitizado antes de entrar na tela, e para conferir um anexo antes
  // de enviar o texto puro ja resolve.
  const { value } = await mammoth.extractRawText({ buffer: bytes });
  return { tipo: "texto", texto: String(value || "").trim() };
}
