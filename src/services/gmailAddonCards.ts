// Pecas do JSON de cartao que o Google desenha no painel lateral do Gmail.
//
// O complemento do Workspace nao aceita HTML proprio: a tela e um "cartao" com
// componentes fixos (texto, campo, lista, interruptor, botao). Estas funcoes so
// montam esse JSON; a regra de negocio fica no controller.
//
// Formato: Card v2 do Google Workspace, resposta como RenderActions (ver
// `resposta`). Tudo que fala com o formato do Google mora aqui, para um ajuste
// de formato (o Google recusa campo desconhecido) ser em um lugar so.

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
  // Secao recolhida, mostrando so os N primeiros widgets. So para secao SEM
  // campo de formulario: o que fica escondido nao e garantido no evento.
  recolhida?: number;
}

// Cor de botao (0..1 por canal, como o Google espera).
export interface Cor {
  red: number;
  green: number;
  blue: number;
}

export interface Botao {
  texto: string;
  acao: Acao;
  cor?: Cor;
}

// Icones prontos do Google (knownIcon). So os que o painel usa.
export type Icone =
  | "EMAIL"
  | "PERSON"
  | "MULTIPLE_PEOPLE"
  | "BOOKMARK"
  | "CLOCK"
  | "DESCRIPTION"
  | "STAR"
  | "STORE"
  | "CONFIRMATION_NUMBER_ICON";

function botaoJson(b: Botao): Widget {
  return {
    text: b.texto,
    onClick: { action: b.acao },
    ...(b.cor ? { color: b.cor } : {}),
  };
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

// Linha com icone: rotulo pequeno em cima, valor, rodape e um botao opcional a
// direita. E o "jeito Google" de mostrar um dado escolhido. `texto` ja vem em
// HTML (quem chama escapa o que for dado de fora).
export function item(p: {
  icone?: Icone;
  rotulo?: string;
  texto: string;
  rodape?: string;
  botao?: Botao;
}): Widget {
  return {
    decoratedText: {
      ...(p.icone ? { startIcon: { knownIcon: p.icone } } : {}),
      ...(p.rotulo ? { topLabel: p.rotulo } : {}),
      text: p.texto,
      ...(p.rodape ? { bottomLabel: p.rodape } : {}),
      wrapText: true,
      ...(p.botao ? { button: botaoJson(p.botao) } : {}),
    },
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

export function botoes(lista: Botao[]): Widget {
  return { buttonList: { buttons: lista.map(botaoJson) } };
}

export function cartao(p: {
  titulo: string;
  subtitulo?: string;
  // Imagem pequena ao lado do titulo (o logo).
  imagem?: string;
  secoes: Secao[];
  botaoPrincipal?: Botao;
  botaoSecundario?: Botao;
}): Record<string, unknown> {
  return {
    header: {
      title: p.titulo,
      ...(p.subtitulo ? { subtitle: p.subtitulo } : {}),
      ...(p.imagem
        ? { imageUrl: p.imagem, imageType: "SQUARE", imageAltText: "Contas" }
        : {}),
    },
    sections: p.secoes
      .filter((s) => s.widgets.length)
      .map((s) => ({
        ...(s.titulo ? { header: s.titulo } : {}),
        ...(s.recolhida !== undefined && s.widgets.length > s.recolhida
          ? { collapsible: true, uncollapsibleWidgetsCount: s.recolhida }
          : {}),
        widgets: s.widgets,
      })),
    ...(p.botaoPrincipal
      ? {
          fixedFooter: {
            primaryButton: botaoJson(p.botaoPrincipal),
            ...(p.botaoSecundario
              ? { secondaryButton: botaoJson(p.botaoSecundario) }
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
//
// O corpo da resposta JA E o RenderActions: `{ action: ... }` na raiz. Os
// exemplos da documentacao embrulham em `{ renderActions: ... }`, mas o Gmail
// recusou assim no 1o teste real (28/10/2026): "Cannot find field: renderActions
// in message google.apps.card.v1.RenderActions".
export const resposta = {
  empurrar: (card: Record<string, unknown>) => ({
    action: { navigations: [{ pushCard: card }] },
  }),
  atualizar: (card: Record<string, unknown>) => ({
    action: { navigations: [{ updateCard: card }] },
  }),
  aviso: (texto: string) => ({
    action: { notification: { text: texto } },
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
