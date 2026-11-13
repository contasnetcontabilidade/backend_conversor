import { Redis } from "@upstash/redis";
import { waitUntil } from "@vercel/functions";
import { getErrorMessage } from "../lib/errors";
import { ramaisConectados } from "./ably";
import { lerNomesDosRamais } from "./usage";

// Aba "Online" do /admin: quem esta com o app aberto agora, em qual versao e
// desde quando.
//
// - Online: ocupacao dos canais do Ably (ver ramaisConectados).
// - Versao: desde a 1.9.5 o proprio app manda versao, setor e nome do PC no
//   pedido de token do Ably, que sai ao abrir e a cada renovacao do token.
//   Fica no registro "a:<ramal>", separado do "r:<ramal>" de baixo: a anotacao
//   pelo User-Agent nao traz setor nem PC, e sobrescreveria os dois.
// - Versoes anteriores: o Electron poe "<nome-do-app>/<versao>" no User-Agent
//   de toda chamada feita pela TELA do app. As do processo principal (vinculo,
//   foto, token do Ably) saem como "node" e nao servem. A ultima versao vista e
//   anotada em dois pontos: nas chamadas com ramal (previa, criar, resumo,
//   feedback; middleware versaoApp) e na conferencia das Sugestoes, que traz a
//   conta Google e o setor e roda sozinha ~20 s depois de o app abrir.
//
// Redis: o plano gratuito (500 mil comandos/mes) ja esta apertado. Cada
// instancia grava no maximo 1x por hora por pessoa (memoria abaixo), mais 1x
// por dia o "abriu as". O painel le 3 comandos por atualizacao.

let redis: Redis | null = null;
function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  if (!redis) redis = new Redis({ url, token });
  return redis;
}

const KEY_VISTO = "online:visto"; // HASH  a:<ramal> | r:<ramal> | c:<conta> -> Visto (JSON)
const keyAbriu = (dia: string) => `online:abriu:${dia}`; // HASH campo -> ms da 1a chamada do dia
const ABRIU_TTL_SEG = 3 * 24 * 3600; // o painel so le o dia de hoje
export const REGRAVAR_MS = 60 * 60_000;
const RAMAL_DA_CONTA_MS = 12 * 3600_000; // o vinculo conta -> ramal quase nunca muda
const RE_RAMAL = /^[\w.-]{1,20}$/; // o mesmo do /gmail/vinculo

export interface Visto {
  v: string; // versao do app
  t: number; // ms da gravacao (precisao de REGRAVAR_MS)
  r?: string; // ramal (so nos registros por conta; vem do vinculo do app)
  s?: string; // setor do perfil (registros por conta e "a:")
  pc?: string; // nome do PC (so nos registros "a:")
}

// "... (KHTML, like Gecko) conversor-wav-txt-desktop/1.9.4 Chrome/134.0.6998.205 Electron/35.1.2 Safari/537.36"
const RE_VERSAO_UA = /\s[^\s/]+\/(\d+\.\d+\.\d+)\s+Chrome\/[\d.]+\s+Electron\/[\d.]+/;
export function versaoDoUserAgent(ua: unknown): string {
  const m = RE_VERSAO_UA.exec(String(ua || ""));
  return m ? m[1] : "";
}

// Versao e nome do PC que o app manda no pedido de token do Ably. Vem de fora
// e vai para o Redis e para o HTML do painel: so passa o formato esperado.
export function versaoValida(v: unknown): string {
  const s = String(v || "").trim();
  return /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(s) ? s : "";
}
export function pcValido(pc: unknown): string {
  return String(pc || "").trim().replace(/[^\w.-]/g, "").slice(0, 40);
}

export function compararVersoes(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Dia no fuso do escritorio: o "abriu as" de quem abre 22h nao pode cair no
// dia seguinte, como cairia em UTC.
const FMT_DIA = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function diaLocal(ms: number): string {
  return FMT_DIA.format(new Date(ms)); // "2026-11-12"
}

// ---------------------------------------------------------------------------
// Anotar a versao
// ---------------------------------------------------------------------------

export interface Anotado {
  v: string;
  s: string;
  pc?: string;
  t: number;
  dia: string;
}
const anotados = new Map<string, Anotado>();
const ramalDaContaMem = new Map<string, { ramal: string; em: number }>();
let diaComTtl = ""; // ultimo dia em que esta instancia ja pos o EXPIRE no abriu

// O que precisa ir para o Redis agora. Versao, setor ou PC novos gravam na
// hora; o resto espera REGRAVAR_MS. O "abriu" vai 1x por dia (HSETNX: a
// primeira instancia do dia e quem vale).
export function oQueGravar(
  antes: Anotado | undefined,
  v: string,
  s: string,
  agora: number,
  pc = "",
): { visto: boolean; abriu: boolean; dia: string } {
  const dia = diaLocal(agora);
  return {
    visto:
      !antes ||
      antes.v !== v ||
      antes.s !== s ||
      (antes.pc || "") !== pc ||
      agora - antes.t >= REGRAVAR_MS,
    abriu: !antes || antes.dia !== dia,
    dia,
  };
}

export interface RegistroVisto {
  userAgent: unknown;
  ramal?: string; // chamadas que trazem o ramal no corpo ou na query
  conta?: string; // conferencia das Sugestoes (conta Google)
  setor?: string;
  // Pedido de token do Ably (app 1.9.5+): versao e PC vem do proprio app, nao
  // do User-Agent, e o registro e o "a:<ramal>".
  ably?: { versao?: unknown; pc?: unknown };
  // Vinculo conta -> ramal que o app grava ao abrir. So e chamado quando ha o
  // que gravar, e o resultado fica 12 h na memoria (1 GET a menos no Redis).
  ramalDaConta?: () => Promise<string>;
}

// Dev sem Redis: o painel funciona com o que esta instancia viu.
const memVisto = new Map<string, Visto>();
const memAbriu = new Map<string, number>(); // `${dia}|${campo}`

export async function registrarVistoApp(p: RegistroVisto): Promise<void> {
  const ably = p.ably;
  const v = ably ? versaoValida(ably.versao) : versaoDoUserAgent(p.userAgent);
  const conta = ably ? "" : String(p.conta || "").trim().toLowerCase();
  const ramal = String(p.ramal || "").trim();
  const campo = conta
    ? `c:${conta}`
    : RE_RAMAL.test(ramal)
      ? `${ably ? "a" : "r"}:${ramal}`
      : "";
  if (!v || !campo) return;

  const agora = Date.now();
  const setor = conta || ably ? String(p.setor || "").trim().slice(0, 80) : "";
  const pc = ably ? pcValido(ably.pc) : "";
  const antes = anotados.get(campo);
  const g = oQueGravar(antes, v, setor, agora, pc);
  if (!g.visto && !g.abriu) return;
  // Anota antes de gravar: se o Redis falhar, as proximas chamadas nao repetem
  // a falha a cada requisicao (o erro fica no log).
  anotados.set(campo, { v, s: setor, pc, t: g.visto ? agora : antes!.t, dia: g.dia });

  const visto: Visto = { v, t: agora };
  if (conta && g.visto) {
    const r = await ramalGuardado(conta, p.ramalDaConta);
    if (r) visto.r = r;
    if (setor) visto.s = setor;
  }
  if (ably) {
    if (setor) visto.s = setor;
    if (pc) visto.pc = pc;
  }

  const r = getRedis();
  if (!r) {
    if (g.visto) memVisto.set(campo, visto);
    if (g.abriu && !memAbriu.has(`${g.dia}|${campo}`)) memAbriu.set(`${g.dia}|${campo}`, agora);
    return;
  }
  const ops: Promise<unknown>[] = [];
  if (g.visto) ops.push(r.hset(KEY_VISTO, { [campo]: JSON.stringify(visto) }));
  if (g.abriu) {
    ops.push(r.hsetnx(keyAbriu(g.dia), campo, agora));
    if (diaComTtl !== g.dia) {
      diaComTtl = g.dia;
      ops.push(r.expire(keyAbriu(g.dia), ABRIU_TTL_SEG));
    }
  }
  await Promise.all(ops);
}

async function ramalGuardado(
  conta: string,
  buscar?: () => Promise<string>,
): Promise<string> {
  const g = ramalDaContaMem.get(conta);
  if (g && Date.now() - g.em < RAMAL_DA_CONTA_MS) return g.ramal;
  if (!buscar) return "";
  const ramal = String((await buscar().catch(() => "")) || "");
  // Sem vinculo nao guarda: o app grava o vinculo ao abrir, e a proxima
  // gravacao ja pode achar.
  if (ramal) ramalDaContaMem.set(conta, { ramal, em: Date.now() });
  return ramal;
}

// Nunca atrasa nem derruba a chamada do app: roda em segundo plano e so loga.
export function registrarVistoAppNoFundo(p: RegistroVisto): void {
  const tarefa = registrarVistoApp(p).catch((err) =>
    console.warn(
      `[online] nao anotou a versao de ${p.conta || p.ramal}:`,
      getErrorMessage(err),
    ),
  );
  try {
    waitUntil(tarefa);
  } catch {
    // Fora da Vercel o waitUntil nao existe; a tarefa segue no processo local.
  }
}

// ---------------------------------------------------------------------------
// Versao mais nova publicada
// ---------------------------------------------------------------------------

// O mesmo arquivo que o app le para se atualizar (main.js do app): a versao
// que ele lista e a que todo mundo recebe ao reiniciar.
const RELEASES_URL =
  "https://github.com/copperlamb78/update_conversor_ia/releases/latest/download/RELEASES";

export function versaoDoReleases(texto: string): string {
  let maior = "";
  for (const m of String(texto || "").matchAll(/-(\d+\.\d+\.\d+)-(?:full|delta)\.nupkg/g)) {
    if (!maior || compararVersoes(m[1], maior) > 0) maior = m[1];
  }
  return maior;
}

let publicadaCache: { versao: string; erro?: string; em: number } | null = null;
async function versaoPublicada(): Promise<{ versao: string; erro?: string }> {
  const agora = Date.now();
  if (publicadaCache) {
    const validade = publicadaCache.erro ? 60_000 : 10 * 60_000;
    if (agora - publicadaCache.em < validade) return publicadaCache;
  }
  try {
    const resp = await fetch(RELEASES_URL, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`GitHub respondeu ${resp.status}`);
    const versao = versaoDoReleases(await resp.text());
    if (!versao) throw new Error("o RELEASES nao tem versao reconhecivel");
    publicadaCache = { versao, em: agora };
  } catch (err) {
    const erro = getErrorMessage(err);
    console.warn("[online] nao leu a versao publicada no GitHub:", erro);
    publicadaCache = { versao: "", erro, em: agora };
  }
  return publicadaCache;
}

// ---------------------------------------------------------------------------
// Painel
// ---------------------------------------------------------------------------

export type StatusOnline = "online" | "saiu" | "offline";

export interface PessoaOnline {
  ramal: string; // "" quando so se sabe a conta (app sem vinculo de ramal)
  nome: string;
  contas: string[];
  setor: string;
  pc: string; // PC da ultima conexao (app 1.9.5+); "" = nao informado
  versao: string; // "" = ainda sem versao vista
  vistoEm: number | null; // ultima gravacao (precisao de REGRAVAR_MS)
  abriuEm: number | null; // 1a chamada de hoje
  maquinas: number; // conexoes no Ably agora
  status: StatusOnline; // "saiu" = fora agora, mas usou o app hoje
}

export interface PainelOnline {
  geradoEm: number;
  versaoMaisNova: string;
  // "github" = o RELEASES publicado; "vista" = o GitHub nao respondeu e vale a
  // maior versao vista nos apps.
  versaoMaisNovaFonte: "github" | "vista" | "";
  regravarMin: number;
  avisos: string[]; // o que nao deu para ler (o painel mostra, nao esconde)
  pessoas: PessoaOnline[];
}

function lerVisto(valor: unknown): Visto | null {
  let o: unknown = valor;
  if (typeof valor === "string") {
    try {
      o = JSON.parse(valor);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const x = o as Record<string, unknown>;
  if (!x.v) return null;
  return {
    v: String(x.v),
    t: Number(x.t) || 0,
    ...(x.r ? { r: String(x.r) } : {}),
    ...(x.s ? { s: String(x.s) } : {}),
    ...(x.pc ? { pc: String(x.pc) } : {}),
  };
}

// Junta Ably + registros + nomes numa linha por ramal. Pura, para o teste.
// Quem tem conta Google entra pelo ramal do vinculo; sem vinculo, fica numa
// linha so da conta. Os registros "a:" (o proprio app, 1.9.5+) e "r:" do
// mesmo ramal caem na mesma linha.
export function juntarPessoas(e: {
  conectados: Map<string, number>;
  vistos: Record<string, unknown>;
  abriu: Record<string, unknown>;
  nomes: Record<string, string>;
  agora: number;
}): PessoaOnline[] {
  const hoje = diaLocal(e.agora);
  const linhas = new Map<string, PessoaOnline & { t: number; tSetor: number; tPc: number }>();
  const linha = (ramal: string, chaveSemRamal: string) => {
    const k = ramal ? `r:${ramal}` : chaveSemRamal;
    let p = linhas.get(k);
    if (!p) {
      p = {
        ramal,
        nome: "",
        contas: [],
        setor: "",
        pc: "",
        versao: "",
        vistoEm: null,
        abriuEm: null,
        maquinas: (ramal && e.conectados.get(ramal)) || 0,
        status: "offline",
        t: 0,
        tSetor: -1,
        tPc: -1,
      };
      linhas.set(k, p);
    }
    return p;
  };

  for (const ramal of e.conectados.keys()) linha(ramal, "");
  for (const [campo, bruto] of Object.entries(e.vistos)) {
    const visto = lerVisto(bruto);
    if (!visto) continue;
    const conta = campo.startsWith("c:") ? campo.slice(2) : "";
    const p = linha(conta ? visto.r || "" : campo.slice(2), campo);
    if (conta && !p.contas.includes(conta)) p.contas.push(conta);
    // Setor e PC do registro mais recente: quem trocou de setor no perfil ou
    // de maquina aparece com o atual, nao com o que o HASH listou por ultimo.
    if (visto.s && visto.t >= p.tSetor) {
      p.setor = visto.s;
      p.tSetor = visto.t;
    }
    if (visto.pc && visto.t >= p.tPc) {
      p.pc = visto.pc;
      p.tPc = visto.t;
    }
    if (visto.t >= p.t) {
      p.t = visto.t;
      p.versao = visto.v;
      p.vistoEm = visto.t || null;
    }
    const abriu = Number(e.abriu[campo]) || 0;
    if (abriu && (!p.abriuEm || abriu < p.abriuEm)) p.abriuEm = abriu;
  }

  return [...linhas.values()].map(({ t: _t, tSetor: _s, tPc: _p, ...p }): PessoaOnline => {
    const usouHoje = !!p.abriuEm || (!!p.vistoEm && diaLocal(p.vistoEm) === hoje);
    return {
      ...p,
      nome:
        (p.ramal && e.nomes[p.ramal]) ||
        (p.contas[0] ? p.contas[0].split("@")[0] : "") ||
        `Ramal ${p.ramal}`,
      status: p.maquinas > 0 ? "online" : usouHoje ? "saiu" : "offline",
    };
  });
}

async function lerRegistros(
  agora: number,
): Promise<{ vistos: Record<string, unknown>; abriu: Record<string, unknown> }> {
  const dia = diaLocal(agora);
  const r = getRedis();
  if (!r) {
    const abriu: Record<string, number> = {};
    for (const [k, ms] of memAbriu) {
      const [d, campo] = k.split("|");
      if (d === dia) abriu[campo] = ms;
    }
    return { vistos: Object.fromEntries(memVisto), abriu };
  }
  const [vistos, abriu] = await Promise.all([
    r.hgetall<Record<string, unknown>>(KEY_VISTO),
    r.hgetall<Record<string, unknown>>(keyAbriu(dia)),
  ]);
  return { vistos: vistos || {}, abriu: abriu || {} };
}

export async function montarPainelOnline(): Promise<PainelOnline> {
  const agora = Date.now();
  const avisos: string[] = [];
  const falhou = (onde: string, aviso: string) => (err: unknown) => {
    const msg = getErrorMessage(err);
    console.warn(`[online] ${onde}:`, msg);
    avisos.push(`${aviso} (${msg})`);
  };

  const [conectados, registros, nomes, publicada] = await Promise.all([
    ramaisConectados().catch((err) => {
      falhou("Ably", "Não deu para saber quem está online agora")(err);
      return new Map<string, number>();
    }),
    lerRegistros(agora).catch((err) => {
      falhou("registros", "Não deu para ler as versões anotadas")(err);
      return { vistos: {}, abriu: {} };
    }),
    lerNomesDosRamais().catch((err) => {
      falhou("nomes", "Não deu para ler os nomes dos ramais")(err);
      return {} as Record<string, string>;
    }),
    versaoPublicada(),
  ]);

  const pessoas = juntarPessoas({ conectados, ...registros, nomes, agora });
  let versaoMaisNova = publicada.versao;
  let fonte: PainelOnline["versaoMaisNovaFonte"] = versaoMaisNova ? "github" : "";
  if (!versaoMaisNova) {
    for (const p of pessoas) {
      if (p.versao && (!versaoMaisNova || compararVersoes(p.versao, versaoMaisNova) > 0)) {
        versaoMaisNova = p.versao;
      }
    }
    if (versaoMaisNova) fonte = "vista";
    avisos.push(
      `Não deu para ler a versão publicada no GitHub (${publicada.erro || "sem detalhe"})` +
        (versaoMaisNova ? `; usando a maior vista nos apps, ${versaoMaisNova}.` : "."),
    );
  }

  return {
    geradoEm: agora,
    versaoMaisNova,
    versaoMaisNovaFonte: fonte,
    regravarMin: REGRAVAR_MS / 60_000,
    avisos,
    pessoas,
  };
}
