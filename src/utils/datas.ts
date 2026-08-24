// Datas no fuso do escritorio.
//
// A Vercel roda em UTC. `new Date().toISOString().slice(0,10)` devolve o dia
// SEGUINTE a partir das 21h de Brasilia — o que faria a validacao recusar um
// prazo "de hoje" como se fosse passado, toda noite. Tudo que compara datas de
// negocio (prazo, competencia) tem que passar por aqui.

const TZ = "America/Sao_Paulo";

// "2026-08-21" no fuso de Sao Paulo. en-CA formata como AAAA-MM-DD.
export function hojeSaoPaulo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// "2026-08" — competencia do mes corrente.
export function competenciaAtual(): string {
  return hojeSaoPaulo().slice(0, 7);
}

const DIAS = [
  "domingo",
  "segunda-feira",
  "terca-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sabado",
];

// Dia da semana de hoje, por extenso.
//
// Existe porque o modelo erra esse calculo: com a data sozinha no prompt, ele
// resolveu "ate sexta" para um DOMINGO. Dizer o dia da semana e barato e tira
// a conta das maos dele.
export function diaDaSemanaHoje(): string {
  const [a, m, d] = hojeSaoPaulo().split("-").map(Number);
  return DIAS[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
}

// As datas das proximas ocorrencias de cada dia da semana, para o modelo nao
// precisar contar dias: "proxima sexta-feira = 2026-08-28".
export function proximosDiasDaSemana(): string {
  const [a, m, d] = hojeSaoPaulo().split("-").map(Number);
  const base = Date.UTC(a, m - 1, d);
  const saida: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const dt = new Date(base + i * 86400000);
    const iso = dt.toISOString().slice(0, 10);
    saida.push(`${DIAS[dt.getUTCDay()]}=${iso}`);
  }
  return saida.join(", ");
}

// Valida AAAA-MM-DD e que a data existe de fato (31/02 nao passa).
export function ehDataISOValida(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [a, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  return (
    dt.getUTCFullYear() === a &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function ehCompetenciaValida(v: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

// Comparacao lexicografica funciona para AAAA-MM-DD.
export function ehDataPassada(v: string): boolean {
  return v < hojeSaoPaulo();
}
