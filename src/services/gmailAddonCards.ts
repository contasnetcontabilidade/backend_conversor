// Pecas do JSON de cartao que o Google desenha no painel lateral do Gmail.
//
// O complemento do Workspace nao aceita HTML proprio: a tela e um "cartao" com
// componentes fixos (texto, campo, lista, interruptor, botao). Estas funcoes so
// montam esse JSON; a regra de negocio fica no controller.
//
// Formato: Card v2 do Google Workspace, resposta em `renderActions`. Tudo que
// fala com o formato do Google mora aqui, para um ajuste de formato (o Google
// recusa campo desconhecido) ser em um lugar so.

import { isRecord } from "../lib/errors";

export type Widget = Record<string, unknown>;

export interface Acao {
  function: string;
  parameters?: Array<{ key: string; value: string }>;
  loadIndicator?: "SPINNER" | "NONE";
}

export interface ItemLista {
  texto: string;
  valor: string;
  selecionado?: boolean;
}

export interface Secao {
  titulo?: string;
  widgets: Widget[];
}

// O textParagraph interpreta um HTML minimo (<b>, <br>, <font>). Assunto e nome
// de remetente vem de fora, entao tudo que e dado passa por aqui.
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function acao(
  url: string,
  params: Record<string, string | undefined> = {},
): Acao {
  const parameters = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([key, value]) => ({ key, value: String(value) }));
  return {
    function: url,
    ...(parameters.length ? { parameters } : {}),
    loadIndicator: "SPINNER",
  };
}

export function paragrafo(html: string): Widget {
  return { textParagraph: { text: html } };
}

export function rotuloValor(rotulo: string, valor: string): Widget {
  return {
    decoratedText: { topLabel: rotulo, text: esc(valor || "-"), wrapText: true },
  };
}

export function campoTexto(p: {
  nome: string;
  rotulo: string;
  valor?: string;
  multilinha?: boolean;
  dica?: string;
}): Widget {
  return {
    textInput: {
      name: p.nome,
      label: p.rotulo,
      type: p.multilinha ? "MULTIPLE_LINE" : "SINGLE_LINE",
      ...(p.valor ? { value: p.valor } : {}),
      ...(p.dica ? { hintText: p.dica } : {}),
    },
  };
}

// Data so com dia. O Google trabalha com milissegundos da meia-noite UTC; o
// Suite e o desktop usam "AAAA-MM-DD" — a conversao e feita aqui e em lerData.
export function campoData(p: {
  nome: string;
  rotulo: string;
  valorIso?: string;
}): Widget {
  const ms = p.valorIso ? Date.parse(`${p.valorIso}T00:00:00Z`) : NaN;
  return {
    dateTimePicker: {
      name: p.nome,
      label: p.rotulo,
      type: "DATE_ONLY",
      ...(Number.isFinite(ms) ? { valueMsEpoch: String(ms) } : {}),
    },
  };
}

export function lista(p: {
  nome: string;
  rotulo: string;
  itens: ItemLista[];
  tipo?: "DROPDOWN" | "CHECK_BOX";
  aoMudar?: Acao;
}): Widget {
  return {
    selectionInput: {
      name: p.nome,
      label: p.rotulo,
      type: p.tipo || "DROPDOWN",
      items: p.itens.map((i) => ({
        text: i.texto,
        value: i.valor,
        selected: !!i.selecionado,
      })),
      ...(p.aoMudar ? { onChangeAction: p.aoMudar } : {}),
    },
  };
}

export function interruptor(p: {
  nome: string;
  rotulo: string;
  ligado: boolean;
  descricao?: string;
}): Widget {
  return {
    decoratedText: {
      text: esc(p.rotulo),
      ...(p.descricao ? { bottomLabel: p.descricao } : {}),
      wrapText: true,
      switchControl: {
        name: p.nome,
        value: "1",
        selected: p.ligado,
        controlType: "SWITCH",
      },
    },
  };
}

export function botoes(
  lista: Array<{ texto: string; acao: Acao }>,
): Widget {
  return {
    buttonList: {
      buttons: lista.map((b) => ({ text: b.texto, onClick: { action: b.acao } })),
    },
  };
}

export function divisor(): Widget {
  return { divider: {} };
}

export function cartao(p: {
  titulo: string;
  subtitulo?: string;
  secoes: Secao[];
  botaoPrincipal?: { texto: string; acao: Acao };
  botaoSecundario?: { texto: string; acao: Acao };
}): Record<string, unknown> {
  const botao = (b: { texto: string; acao: Acao }) => ({
    text: b.texto,
    onClick: { action: b.acao },
  });
  return {
    header: { title: p.titulo, ...(p.subtitulo ? { subtitle: p.subtitulo } : {}) },
    sections: p.secoes
      .filter((s) => s.widgets.length)
      .map((s) => ({
        ...(s.titulo ? { header: s.titulo } : {}),
        widgets: s.widgets,
      })),
    ...(p.botaoPrincipal
      ? {
          fixedFooter: {
            primaryButton: botao(p.botaoPrincipal),
            ...(p.botaoSecundario
              ? { secondaryButton: botao(p.botaoSecundario) }
              : {}),
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------------

// pushCard abre uma tela nova (o "voltar" do Gmail retorna a anterior);
// updateCard troca a tela atual (usado quando a pessoa so buscou um cliente).
export const resposta = {
  empurrar: (card: Record<string, unknown>) => ({
    renderActions: { action: { navigations: [{ pushCard: card }] } },
  }),
  atualizar: (card: Record<string, unknown>) => ({
    renderActions: { action: { navigations: [{ updateCard: card }] } },
  }),
  aviso: (texto: string) => ({
    renderActions: { action: { notification: { text: texto } } },
  }),
};

// ---------------------------------------------------------------------------
// Leitura do evento que o Google manda
// ---------------------------------------------------------------------------

function comum(evento: unknown): Record<string, unknown> {
  return isRecord(evento) && isRecord(evento.commonEventObject)
    ? evento.commonEventObject
    : {};
}

function entrada(evento: unknown, nome: string): Record<string, unknown> {
  const form = comum(evento).formInputs;
  const e = isRecord(form) ? form[nome] : undefined;
  return isRecord(e) ? e : {};
}

export function lerLista(evento: unknown, nome: string): string[] {
  const s = entrada(evento, nome).stringInputs;
  const v = isRecord(s) ? s.value : undefined;
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

export function lerCampo(evento: unknown, nome: string): string {
  return (lerLista(evento, nome)[0] || "").trim();
}

// Interruptor desligado nao manda nada; ligado manda o `value` dele.
export function lerInterruptor(evento: unknown, nome: string): boolean {
  return lerLista(evento, nome).length > 0;
}

export function lerData(evento: unknown, nome: string): string | undefined {
  const d = entrada(evento, nome).dateInput;
  const ms = isRecord(d) ? Number(d.msSinceEpoch) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

export function lerParametro(evento: unknown, nome: string): string {
  const p = comum(evento).parameters;
  const v = isRecord(p) ? p[nome] : undefined;
  return typeof v === "string" ? v : "";
}
