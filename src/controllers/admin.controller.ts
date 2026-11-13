import { Request, Response } from "express";
import { cotacoesDosDias, custoLinha, getUsdBrl } from "../services/pricing";
import { getRelatorioUso } from "../services/usage";
import { getSaldoDeepgramUsd } from "../services/deepgramSpeech";
import {
  registrarFeedback,
  listarFeedback,
  modeloDoResumo,
  type FeedbackEntry,
} from "../services/feedback";
import {
  registrarErro,
  listarErros,
  limparErros,
  type ErroEntry,
} from "../services/erros";
import { PROMPT_VERSION } from "../services/gemini";
import { listarCustoChamados } from "../services/custoChamados";
import {
  conferirPrecoClaudeSeVencido,
  lerEstadoPrecoClaude,
  lerHistoricoPrecoClaude,
  precoClaudeVigente,
} from "../services/precoClaude";
import { getErrorMessage } from "../lib/errors";
import { montarPainelOnline } from "../services/appOnline";

function senhaAdmin(): string {
  return process.env.ADMIN_PASSWORD || "Contas@2074";
}

function isAdmin(req: Request): boolean {
  const auth = req.header("authorization") || "";
  return auth === `Bearer ${senhaAdmin()}`;
}

// POST /api/feedback — registra feedback do resumo da IA (explicito/implicito).
// Aceita SO campos conhecidos e limitados (nunca a transcricao/conteudo; do
// resumo, so a parte da IA e a versao editada).
export async function feedbackController(req: Request, res: Response) {
  const b = (
    req.body && typeof req.body === "object" ? req.body : {}
  ) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const bool = (v: unknown) => v === true || v === "true";
  // Campos que app antigo nao manda: ausente fica undefined (e nao false/0),
  // senao nao da para separar "app antigo" de "valor zero" na analise.
  const boolOpc = (v: unknown) => (v === undefined ? undefined : bool(v));
  const inteiroOpc = (v: unknown) => {
    const n = Number(v);
    return v === undefined || v === null || !Number.isFinite(n)
      ? undefined
      : Math.min(Math.max(Math.round(n), 0), 1_000_000);
  };
  const fracaoOpc = (v: unknown) => {
    const n = Number(v);
    return v === undefined || v === null || !Number.isFinite(n)
      ? undefined
      : Math.round(Math.min(Math.max(n, 0), 1) * 100) / 100;
  };
  const ratingRaw = str(b.rating);
  // O "modelo" que o app manda e o do seletor, nao o que fez o resumo; vale o
  // que o backend anotou ao gerar este texto (feedback.ts). Sem anotacao
  // (feedback explicito, resumo antigo) fica vazio — melhor que um modelo errado.
  const descTextoIa = str(b.descTextoIa).slice(0, 8000) || undefined;
  const modeloReal = descTextoIa
    ? await modeloDoResumo(descTextoIa).catch((error) => {
        console.warn("[admin:feedback] falha ao achar o modelo:", getErrorMessage(error));
        return undefined;
      })
    : undefined;
  const dv = (
    b.divergencias && typeof b.divergencias === "object" ? b.divergencias : {}
  ) as Record<string, unknown>;

  const entry: FeedbackEntry = {
    ts: new Date().toISOString(),
    tipo: b.tipo === "implicito" ? "implicito" : "explicito",
    origem: str(b.origem).slice(0, 20) || "ligacao",
    id: str(b.id).slice(0, 120),
    promptVersion: PROMPT_VERSION, // carimbo do prompt vigente (autoritativo)
    modelo: modeloReal,
    ramal: str(b.ramal).slice(0, 40) || undefined,
    usuario: str(b.usuario).slice(0, 120) || undefined,
    rating: ratingRaw === "up" || ratingRaw === "down" ? ratingRaw : null,
    tags: Array.isArray(b.tags)
      ? b.tags.map((t) => String(t).slice(0, 60)).slice(0, 10)
      : [],
    // Era 1000 e cortava sem avisar: a avaliacao de 21/10 com as dicas para o
    // prompt (1000 caracteres cravados) perdeu o final. 5000 cabe uma critica
    // detalhada e continua barato no Redis.
    comentario: str(b.comentario).slice(0, 5000) || undefined,
    divergencias: {
      clienteMudou: bool(dv.clienteMudou),
      clienteTinhaSugestao: bool(dv.clienteTinhaSugestao),
      clienteVia: str(dv.clienteVia).slice(0, 20),
      setorMudou: bool(dv.setorMudou),
      executorMudou: bool(dv.executorMudou),
      executorModo: str(dv.executorModo).slice(0, 20) || undefined,
      assuntoSugerido: str(dv.assuntoSugerido).slice(0, 120),
      assuntoFinal: str(dv.assuntoFinal).slice(0, 120),
      assuntoMudou: bool(dv.assuntoMudou),
      finalizadoSugerido: bool(dv.finalizadoSugerido),
      finalizadoFinal: bool(dv.finalizadoFinal),
      finalizadoIa: boolOpc(dv.finalizadoIa),
    },
    descEditada: bool(b.descEditada),
    descTamSistema: inteiroOpc(b.descTamSistema),
    descTamFinal: inteiroOpc(b.descTamFinal),
    descPalavrasMantidas: fracaoOpc(b.descPalavrasMantidas),
    // Teto folgado: o resumo (resumo + pontos + providencias) fica em ~1-3 mil
    // caracteres; o corte so existe para um corpo anormal nao inchar a lista.
    descTextoIa,
    descTextoFinal: str(b.descTextoFinal).slice(0, 8000) || undefined,
    iaOk: b.iaOk === undefined ? undefined : bool(b.iaOk),
  };
  await registrarFeedback(entry).catch(() => undefined);
  res.status(200).json({ ok: true });
}

// POST /api/erros — o desktop reporta um erro que estourou na maquina do usuario.
// Aceita SO campos conhecidos e capados (nunca transcricao/resumo/conteudo).
export async function erroController(req: Request, res: Response) {
  const b = (
    req.body && typeof req.body === "object" ? req.body : {}
  ) as Record<string, unknown>;
  const str = (v: unknown, max: number) =>
    typeof v === "string" ? v.slice(0, max) : "";

  const mensagem = str(b.mensagem, 500).trim();
  if (!mensagem) {
    // Sem mensagem nao ha o que investigar — descarta em silencio (o app nao
    // deve nem perceber; telemetria jamais atrapalha o fluxo do usuario).
    res.status(200).json({ ok: true, ignorado: true });
    return;
  }

  const entry: ErroEntry = {
    ts: new Date().toISOString(),
    origem: str(b.origem, 20) || "desktop",
    tipo: str(b.tipo, 20) || "erro",
    mensagem,
    stack: str(b.stack, 2000) || undefined,
    contexto: str(b.contexto, 120) || undefined,
    versao: str(b.versao, 20) || undefined,
    ramal: str(b.ramal, 40) || undefined,
    usuario: str(b.usuario, 120) || undefined,
    plataforma: str(b.plataforma, 60) || undefined,
  };
  await registrarErro(entry).catch(() => undefined);
  res.status(200).json({ ok: true });
}

// GET /api/admin/erros — lista os erros reportados (protegido pela senha).
export async function adminErrosController(req: Request, res: Response) {
  if (!isAdmin(req)) {
    res.status(401).json({ ok: false, message: "Nao autorizado." });
    return;
  }
  const itens = await listarErros(300).catch(() => []);
  res.status(200).json({ ok: true, itens });
}

// POST /api/admin/erros/limpar — zera a lista depois de tratar os erros.
export async function adminErrosLimparController(req: Request, res: Response) {
  if (!isAdmin(req)) {
    res.status(401).json({ ok: false, message: "Nao autorizado." });
    return;
  }
  await limparErros().catch(() => undefined);
  res.status(200).json({ ok: true });
}

// GET /api/admin/online — aba "Online": quem esta com o app aberto agora, em
// qual versao e de qual setor (protegido pela senha do admin). O que nao deu
// para ler (Ably, Redis, GitHub) vem em `avisos`, e a aba mostra.
export async function adminOnlineController(req: Request, res: Response) {
  if (!isAdmin(req)) {
    res.status(401).json({ ok: false, message: "Nao autorizado." });
    return;
  }
  const data = await montarPainelOnline();
  res.status(200).json({ ok: true, data });
}

// GET /api/admin/feedback — lista os feedbacks (protegido pela senha do admin).
export async function adminFeedbackController(req: Request, res: Response) {
  if (!isAdmin(req)) {
    res.status(401).json({ ok: false, message: "Nao autorizado." });
    return;
  }
  // Tudo, sem teto: o export daqui e a base de analise do prompt.
  const itens = await listarFeedback().catch((err) => {
    console.error("[admin:feedback] falha ao ler o feedback:", err);
    return [];
  });
  res.status(200).json({ ok: true, itens });
}

// GET /api/admin/uso — relatorio de tokens + custo (protegido por senha).
export async function adminUsoController(req: Request, res: Response) {
  if (!isAdmin(req)) {
    res.status(401).json({ ok: false, message: "Nao autorizado." });
    return;
  }

  // Abrir o painel tambem confere o preco do Claude no site (no maximo 1x/dia),
  // ANTES de ler o historico, para o calculo ja sair com o preco de hoje.
  await conferirPrecoClaudeSeVencido().catch((error) =>
    console.warn("[admin] conferencia do preco do Claude falhou:", getErrorMessage(error)),
  );
  const [
    relatorio,
    cotacao,
    deepgramSaldoUsd,
    chamados,
    historicoClaude,
    estadoPrecoClaude,
  ] = await Promise.all([
    getRelatorioUso(),
    getUsdBrl(),
    getSaldoDeepgramUsd(), // null se a key nao tiver billing:read
    listarCustoChamados().catch(() => []), // custo por cliente/assunto
    lerHistoricoPrecoClaude(),
    lerEstadoPrecoClaude(),
  ]);

  // Cambio de fechamento de cada dia com gasto: o R$ de um dia nao muda mais
  // quando o dolar mexe. Dia sem fechamento gravado (hoje, fonte fora do ar)
  // usa a cotacao atual — no servidor e no JS da pagina.
  const cambioDia = await cotacoesDosDias([
    ...relatorio.porDiaModelo.map((d) => d.dia),
    ...chamados.map((c) => c.dia),
  ]);
  const cotacaoDoDia = (dia: string) => cambioDia.cotacoes[dia] ?? cotacao;

  // Detalhe por dia+modelo+op, ja com custo por linha (precificado por modelo).
  // O frontend agrega/filtra por periodo em cima disto. O Claude usa o preco
  // vigente em cada dia (historico lido do site).
  const porDiaModelo = relatorio.porDiaModelo.map((d) => ({
    ...d,
    custoUsd: custoLinha(d.model, d.inputTokens, d.outputTokens, d.audioSec, {
      dia: d.dia,
      historicoClaude,
    }),
  }));

  // Agregado por modelo+operacao (todo o periodo). Soma o custo ja calculado
  // dia a dia: com o preco mudando no tempo, precificar o total do periodo com
  // um preco so daria errado.
  const custoPorModeloOp = new Map<string, number>();
  for (const d of porDiaModelo) {
    const chave = `${d.model}::${d.op}`;
    custoPorModeloOp.set(chave, (custoPorModeloOp.get(chave) || 0) + d.custoUsd);
  }
  const linhas = relatorio.linhas
    .map((l) => ({
      ...l,
      custoUsd: custoPorModeloOp.get(`${l.model}::${l.op}`) || 0,
    }))
    .sort((a, b) => b.custoUsd - a.custoUsd);

  // Detalhe por dia+ramal+op (colapsa o modelo apos precificar).
  const ramalMap = new Map<
    string,
    {
      dia: string;
      ramal: string;
      usuario: string;
      op: string;
      inputTokens: number;
      outputTokens: number;
      calls: number;
      audioSec: number;
      custoUsd: number;
    }
  >();
  for (const it of relatorio.porRamal) {
    const chave = `${it.dia}::${it.ramal}::${it.op}`;
    const cur =
      ramalMap.get(chave) ||
      {
        dia: it.dia,
        ramal: it.ramal,
        usuario: it.usuario,
        op: it.op,
        inputTokens: 0,
        outputTokens: 0,
        calls: 0,
        audioSec: 0,
        custoUsd: 0,
      };
    cur.inputTokens += it.inputTokens;
    cur.outputTokens += it.outputTokens;
    cur.calls += it.calls;
    cur.audioSec += it.audioSec;
    cur.custoUsd += custoLinha(it.model, it.inputTokens, it.outputTokens, it.audioSec, {
      dia: it.dia,
      historicoClaude,
    });
    if (!cur.usuario && it.usuario) cur.usuario = it.usuario;
    ramalMap.set(chave, cur);
  }
  const porRamal = Array.from(ramalMap.values());

  // Detalhe por dia+fonte+op (colapsa o modelo apos precificar). Para separar
  // ligacao x e-mail no painel.
  const fonteMap = new Map<
    string,
    {
      dia: string;
      fonte: string;
      op: string;
      inputTokens: number;
      outputTokens: number;
      calls: number;
      audioSec: number;
      custoUsd: number;
    }
  >();
  for (const it of relatorio.porFonte) {
    const chave = `${it.dia}::${it.fonte}::${it.op}`;
    const cur =
      fonteMap.get(chave) ||
      {
        dia: it.dia,
        fonte: it.fonte,
        op: it.op,
        inputTokens: 0,
        outputTokens: 0,
        calls: 0,
        audioSec: 0,
        custoUsd: 0,
      };
    cur.inputTokens += it.inputTokens;
    cur.outputTokens += it.outputTokens;
    cur.calls += it.calls;
    cur.audioSec += it.audioSec;
    cur.custoUsd += custoLinha(it.model, it.inputTokens, it.outputTokens, it.audioSec, {
      dia: it.dia,
      historicoClaude,
    });
    fonteMap.set(chave, cur);
  }
  const porFonte = Array.from(fonteMap.values());

  // Totais e "por ligacao" (todo o periodo) — referencia; o frontend recalcula
  // os valores do periodo selecionado a partir de porDiaModelo/porRamal.
  const totais = linhas.reduce(
    (acc, l) => {
      acc.inputTokens += l.inputTokens;
      acc.outputTokens += l.outputTokens;
      acc.calls += l.calls;
      acc.audioSec += l.audioSec;
      acc.custoUsd += l.custoUsd;
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, calls: 0, audioSec: 0, custoUsd: 0 },
  );
  // Dia a dia, cada um no seu cambio (o total em US$ x cotacao de hoje
  // reescreveria o passado).
  const custoBrl = porDiaModelo.reduce(
    (s, d) => s + d.custoUsd * cotacaoDoDia(d.dia),
    0,
  );

  // Saldo do Claude ESTIMADO: a Anthropic nao tem API de saldo, e conta
  // individual nem acessa a Admin API de custos (testado em 19/10/2026). Entao e
  // a franquia mensal menos o gasto em Claude que ESTE backend registrou no mes
  // (UTC, o mesmo dia das chaves de uso). Uso da mesma conta fora daqui nao entra.
  const creditoMensalUsd =
    Number(process.env.CLAUDE_CREDITO_MENSAL_USD) || 200;
  const mesAtual = new Date().toISOString().slice(0, 7);
  const gastoMesUsd = porDiaModelo
    .filter((d) => d.dia.startsWith(mesAtual) && /^claude-/.test(d.model))
    .reduce((s, d) => s + d.custoUsd, 0);

  res.status(200).json({
    ok: true,
    configurado: relatorio.configurado,
    cotacao, // atual: hoje e dias sem fechamento gravado
    cotacoes: cambioDia.cotacoes, // AAAA-MM-DD -> fechamento daquele dia
    cambioDia: cambioDia.estado, // falha da busca do historico, se houver
    deepgramSaldoUsd, // creditos restantes no Deepgram (null se indisponivel)
    claudeSaldo: {
      creditoMensalUsd,
      gastoMesUsd,
      saldoEstimadoUsd: creditoMensalUsd - gastoMesUsd,
    },
    // De onde vem o preco do Claude: "site" depois da 1a leitura de
    // claude.com/pricing; "codigo" antes disso (tabela do pricing.ts).
    claudePreco: {
      ...precoClaudeVigente(historicoClaude),
      fonte: historicoClaude.length ? "site" : "codigo",
      ...estadoPrecoClaude,
    },
    totais: {
      ...totais,
      tokens: totais.inputTokens + totais.outputTokens,
      custoBrl,
    },
    linhas,
    porDiaModelo,
    porRamal,
    porFonte,
    chamados, // 1 linha por chamado criado (cliente, assunto, custo)
    // Ramais de teste (devs). NAO sao escondidos: o painel os mostra numa
    // linha propria, para o gasto continuar visivel sem contaminar o numero
    // de 'usuario gerou IA e desistiu'.
    // Ate esta data o app NAO enviava o ramal no chamado, entao nao ha como
    // atribuir o gasto. Contar aquilo como desperdicio seria mentira: na pratica
    // quase tudo virou chamado. O painel trata o periodo anterior como convertido.
    semChamadoDesde: String(process.env.SEM_CHAMADO_DESDE || "2026-08-19").trim(),
    // Padrao 258 (ramal do desenvolvedor). Vira variavel de ambiente quando
    // houver mais de um ramal de teste — sem isto o gasto de desenvolvimento
    // entrava na conta de "IA sem chamado" como se fosse uso real.
    ramaisTeste: String(process.env.RAMAIS_TESTE || "258")
      .split(/[,;\s]+/)
      .map((r) => r.trim())
      .filter(Boolean),
  });
}

// GET /admin — pagina do painel (self-contained; pede a senha e busca os dados).
export function adminPageController(_req: Request, res: Response) {
  res.status(200).type("html").send(PAGINA_ADMIN);
}

const PAGINA_ADMIN = `<!doctype html>
<html lang="pt-BR" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Painel de Custos IA · Contas</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<!-- Mesma biblioteca de icones do app (renderer): Lucide. Usa <i data-lucide="nome">,
     que o lucide.createIcons() troca por um <svg class="lucide lucide-nome">. -->
<script src="https://unpkg.com/lucide@latest"></script>
<style>
:root{--brand:#0b3d66;--brand-2:#12578f;--accent:#1fa971;--accent-soft:rgba(31,169,113,.15);
--gold:#e0a93b;--danger:#e5484d;--radius:14px;--radius-sm:10px}
html[data-theme=dark]{--bg:#0e1621;--bg-grad:radial-gradient(1200px 600px at 82% -12%,#123457 0,transparent 60%),radial-gradient(900px 520px at -10% -5%,#0d2a44 0,transparent 55%);
--card:#16202e;--card-2:#1b273a;--border:#223145;--text:#e7ecf6;--muted:#93a0bd;--shadow:0 10px 30px rgba(0,0,0,.35)}
html[data-theme=light]{--bg:#f5f7fa;--bg-grad:none;--card:#fff;--card-2:#f2f6fb;--border:#e2e8f0;--text:#0e1621;--muted:#5a6b85;--shadow:0 10px 26px rgba(11,61,102,.1)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;background:var(--bg);background-image:var(--bg-grad);color:var(--text);min-height:100vh}
.wrap{max-width:1200px;margin:0 auto;padding:20px 20px 60px}
.topbar{display:flex;align-items:center;gap:16px;margin-bottom:22px}
/* Escopado na topbar: solto, o ".brand" pegava tambem os cards ".card brand"
   e deixava rotulo/valor/subtitulo lado a lado. */
.topbar .brand{display:flex;align-items:center;gap:12px}
.logo{width:42px;height:42px;border-radius:11px;background:linear-gradient(135deg,var(--brand) 0%,var(--brand-2) 55%,var(--accent) 130%);display:grid;place-items:center;color:#fff;font-weight:800;font-size:18px;box-shadow:0 6px 16px rgba(11,61,102,.35)}
.name b{display:block;font-size:15px}.name span{font-size:12px;color:var(--muted)}
.spacer{flex:1}
.pill{font-size:12px;color:var(--muted);border:1px solid var(--border);padding:6px 12px;border-radius:999px}
.icon-btn{background:var(--card);border:1px solid var(--border);color:var(--text);width:40px;height:40px;border-radius:11px;cursor:pointer;font-size:16px}
h1{font-size:22px;margin-bottom:4px}.sub{color:var(--muted);font-size:13px;margin-bottom:18px}
.period{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:20px}
.seg{display:inline-flex;background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.seg button{background:transparent;border:none;color:var(--muted);padding:8px 12px;cursor:pointer;font-size:12.5px}
.seg button.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.period input[type=date]{background:var(--card);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:7px 9px;font-size:12.5px}
.period label{font-size:12px;color:var(--muted)}
.period .cambio{width:84px;background:var(--card);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:7px 9px;font-size:12.5px}
.mini-btn{background:var(--card);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:8px 12px;cursor:pointer;font-size:12.5px}
.mini-btn:hover{border-color:var(--accent)}
.nov-ov{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(6,16,30,.6);padding:20px}
.nov-ov.hidden{display:none}
.nov-card{width:100%;max-width:460px;background:var(--card);border:1px solid var(--border);border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.5);overflow:hidden}
.nov-h{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border);font-size:15px;font-weight:700;color:var(--text)}
.nov-h button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:15px;line-height:1}
.nov-l{padding:6px 16px;max-height:60vh;overflow:auto}
.nov-it{display:flex;gap:11px;padding:11px 0;border-bottom:1px solid var(--border)}
.nov-it:last-child{border-bottom:none}
.nov-it .em{font-size:18px;flex:0 0 auto;line-height:1.4}
.nov-it .tx{font-size:13px;color:var(--text);line-height:1.5}
.nov-f{padding:12px 16px;border-top:1px solid var(--border);text-align:right}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px}
.card .v{min-width:0;word-break:break-word}
@media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){.cards{grid-template-columns:1fr}}
.card{background:linear-gradient(180deg,var(--card-2),var(--card));border:1px solid var(--border);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--border)}
.card.brand::before{background:var(--brand-2)}.card.accent::before{background:var(--accent)}.card.gold::before{background:var(--gold)}.card.teal::before{background:#14b8a6}
.card .k{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.card .v{font-size:23px;font-weight:700;margin-top:8px}
.card .s{font-size:12px;color:var(--muted);margin-top:4px}
.card.accent .v{color:var(--accent)}.card.gold .v{color:var(--gold)}.card.teal .v{color:#2dd4bf}
.delta{font-weight:600}.delta.up{color:var(--danger)}.delta.down{color:var(--accent)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:22px}
@media(max-width:900px){.grid2{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow);margin-bottom:22px}
.panel h3{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px}
.chart-box{position:relative;height:260px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.5px}
th.sortable{cursor:pointer;user-select:none}th.sortable:hover{color:var(--text)}
tbody tr:hover{background:var(--accent-soft)}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--accent-soft);color:var(--accent)}
.badge.resumo{background:rgba(224,169,59,.14);color:var(--gold)}
.badge.erro{background:rgba(229,72,77,.16);color:var(--danger);margin-left:2px}
.er-msg{font-family:Consolas,"Courier New",monospace;font-size:12px;word-break:break-word}
.er-det{margin-top:4px}
.er-det summary{cursor:pointer;color:var(--muted);font-size:11.5px}
.er-det pre{margin-top:6px;padding:8px;background:var(--card-2);border:1px solid var(--border);border-radius:8px;
  font-size:11px;line-height:1.45;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.right{text-align:right}
.note{font-size:12.5px;color:var(--muted);background:var(--accent-soft);border:1px solid var(--border);border-radius:9px;padding:9px 12px;margin-bottom:14px}
.rank{list-style:none}
.rank li{display:flex;justify-content:space-between;gap:12px;padding:9px 4px;border-bottom:1px solid var(--border);font-size:13px}
.rank li:last-child{border-bottom:none}
.pag{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:8px 4px 2px;font-size:12px;color:var(--muted)}
.pag:empty{display:none}
.pag button{background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:3px 10px;cursor:pointer;font-size:12px}
.pag button:disabled{opacity:.4;cursor:default}
.pag button:not(:disabled):hover{border-color:var(--accent)}
.rank .d{color:var(--muted)}
#login{position:fixed;inset:0;background:rgba(6,12,20,.85);display:flex;align-items:center;justify-content:center;z-index:50}
.login-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:30px;width:360px;max-width:92vw;box-shadow:0 24px 60px rgba(0,0,0,.5);text-align:center}
.login-card h2{margin-bottom:8px}.login-card p{color:var(--muted);font-size:13px;margin-bottom:18px}
.login-card input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:15px;margin-bottom:12px}
.login-card button{width:100%;padding:12px;border-radius:10px;border:none;background:linear-gradient(135deg,var(--brand),var(--brand-2));color:#fff;font-weight:700;font-size:15px;cursor:pointer}
.login-err{color:var(--danger);font-size:13px;margin-top:10px;min-height:18px}
.hidden{display:none!important}
.muted{color:var(--muted)}
/* ---- Icones (Lucide) ----------------------------------------------------
   O lucide troca o <i data-lucide> por um <svg class="lucide lucide-nome">,
   entao os seletores tem que ser por "svg" (o "i" some). Sem dimensionar, o
   icone vem no padrao 24px e estoura os botoes. */
svg.lucide{width:16px;height:16px;flex:0 0 auto;vertical-align:-.16em}
.icon-btn{display:inline-grid;place-items:center}
.icon-btn svg.lucide{width:18px;height:18px}
html[data-theme=dark] #tema .lucide-moon{display:none}
html[data-theme=light] #tema .lucide-sun{display:none}
/* Troca de tema com "agua", a mesma do app desktop (via View Transitions): a
   foto do tema antigo fica parada embaixo e o tema novo aparece pela poca
   d'agua que o JS monta a cada troca (svgAgua, no script desta pagina) e
   entrega na variavel --tinta. A poca cresce animada dentro do SVG; sem a
   variavel, nao ha mascara e o tema novo aparece de uma vez. */
::view-transition-old(root),::view-transition-new(root){animation:none;mix-blend-mode:normal}
::view-transition-new(root){-webkit-mask-image:var(--tinta,none);mask-image:var(--tinta,none);
-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-size:100% 100%;mask-size:100% 100%;
-webkit-mask-position:0 0;mask-position:0 0}
.seg button{display:inline-flex;align-items:center;gap:6px}
.seg button svg.lucide{width:15px;height:15px}
.mini-btn{display:inline-flex;align-items:center;gap:6px}
.mini-btn svg.lucide{width:15px;height:15px}
.card .k{display:flex;align-items:center;gap:6px}
.card .k svg.lucide{width:14px;height:14px}
.panel h3{display:flex;align-items:center;gap:8px}
.panel h3 svg.lucide{width:15px;height:15px;color:var(--accent)}
.delta svg.lucide{width:13px;height:13px;vertical-align:-.12em}
td svg.lucide,#fb-stats svg.lucide{width:15px;height:15px}
.av-up{color:var(--accent)}.av-down{color:var(--danger)}
.nov-it .em svg.lucide{width:18px;height:18px;color:var(--accent)}
.nov-h b{display:inline-flex;align-items:center;gap:8px}
.nov-h b svg.lucide{color:var(--gold)}
.login-card h2{display:flex;align-items:center;justify-content:center;gap:8px}
.login-card h2 svg.lucide{width:18px;height:18px;color:var(--muted)}
.titlebar{display:none}
body.electron{padding-top:40px}
body.electron .titlebar{position:fixed;top:0;left:0;right:0;height:40px;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:0 6px 0 14px;background:var(--card);border-bottom:1px solid var(--border);-webkit-app-region:drag}
.titlebar .tb-left{display:flex;align-items:center;gap:10px;min-width:0}
.titlebar .tb-logo{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--brand),var(--brand-2) 60%,var(--accent) 130%);display:grid;place-items:center;color:#fff;font-weight:800;font-size:11px}
.titlebar .tb-title{font-size:12.5px;font-weight:600;color:var(--text);white-space:nowrap}
.titlebar .tb-actions{display:flex;gap:2px;-webkit-app-region:no-drag}
.titlebar .tb-btn{width:40px;height:28px;display:grid;place-items:center;background:transparent;border:none;border-radius:7px;color:var(--muted);cursor:pointer;transition:background .15s,color .15s}
.titlebar .tb-btn:hover{background:var(--card-2);color:var(--text)}
.titlebar .tb-close:hover{background:var(--danger);color:#fff}
.titlebar .ic-restore{display:none}
body.win-max .titlebar .ic-max{display:none}
body.win-max .titlebar .ic-restore{display:inline}
/* ---- Aba Online -----------------------------------------------------------
   Verde e dourado como texto nao passam contraste no tema claro: la usam um
   tom mais escuro. As bolinhas de status ficam iguais nos dois temas. */
html[data-theme=dark]{--on-ok:#1fa971;--on-old:#e0a93b;--on-maq:#9cc7ef}
html[data-theme=light]{--on-ok:#137a50;--on-old:#8a5c00;--on-maq:#12578f}
.on-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.on-erro{font-size:12.5px;color:var(--text);background:rgba(229,72,77,.1);border:1px solid rgba(229,72,77,.4);border-radius:9px;padding:9px 12px;margin-bottom:10px}
.on-top{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:18px}
.on-top>.panel{flex:1 1 340px;margin-bottom:0}
.on-resumo{display:flex;align-items:center;gap:18px}
.on-anel{flex:0 0 auto}
.on-anel .trilho{stroke:var(--border)}.on-anel .arco{stroke:var(--accent)}
.on-anel .n{fill:var(--text);font-size:30px;font-weight:700}.on-anel .de{fill:var(--muted);font-size:13px}
.on-big{font-size:20px;font-weight:700}
.on-sub{font-size:13px;color:var(--muted);margin-top:4px;line-height:1.6}
.on-vers{display:flex;flex-direction:column;gap:9px}
.on-ver{display:grid;grid-template-columns:72px minmax(0,1fr) 28px;gap:10px;align-items:center;font-size:12.5px}
.on-ver .bar{height:10px;background:var(--border);border-radius:999px;overflow:hidden}
.on-ver .bar i{display:block;height:100%;border-radius:999px}
.on-ok{color:var(--on-ok)}.on-old{color:var(--on-old)}.on-nd{color:var(--muted)}
.bg-ok{background:var(--accent)}.bg-old{background:var(--gold)}.bg-nd{background:var(--muted)}
.on-alerta{background:rgba(224,169,59,.08);border:1px solid rgba(224,169,59,.35);border-radius:var(--radius);padding:14px 16px;margin-bottom:22px}
.on-alerta.tudo-ok{background:var(--accent-soft);border-color:var(--border)}
.on-alerta .tit{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;color:var(--on-old);margin-bottom:10px}
.on-alerta.tudo-ok .tit{color:var(--on-ok);margin-bottom:0}
.on-alerta .tit svg.lucide{width:17px;height:17px}
.on-chips{display:flex;flex-wrap:wrap;gap:8px}
.on-chip{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;background:var(--card);border:1px solid var(--border);border-radius:999px;padding:5px 12px}
.on-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#5b6880}
.on-dot.online{background:#1fa971}.on-dot.saiu{background:#e0a93b}
.on-sec{margin-bottom:26px}
.on-sec-h{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.on-sec-h h2{font-size:16px}
.on-sec-h .n{font-size:12.5px;color:var(--muted)}
.on-sec-h .bar{flex:0 1 160px;min-width:80px;height:6px;background:var(--border);border-radius:999px;overflow:hidden}
.on-sec-h .bar i{display:block;height:100%;background:var(--accent)}
.on-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.on-card{background:linear-gradient(180deg,var(--card-2),var(--card));border:1px solid var(--border);border-radius:12px;padding:12px;min-width:0}
.on-card.fora{background:transparent;border-style:dashed}
.on-card .cab{display:flex;align-items:center;gap:10px}
.on-av{position:relative;flex:0 0 auto;width:38px;height:38px;border-radius:50%;background:var(--brand-2);color:#fff;display:grid;place-items:center;font-size:13px;font-weight:700}
.on-card.fora .on-av{background:#2c3b52}
.on-av .on-dot{position:absolute;right:-1px;bottom:-1px;width:12px;height:12px;border:2px solid var(--card)}
.on-nome{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.on-linha{font-size:12px;color:var(--muted)}
.on-linha.ell{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:8px}
.on-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.on-tag{font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:999px}
.on-tag.ok{background:var(--accent-soft);color:var(--on-ok)}
.on-tag.old{background:rgba(224,169,59,.14);color:var(--on-old)}
.on-tag.nd{background:rgba(147,160,189,.14);color:var(--muted)}
.on-tag.maq{background:rgba(18,87,143,.2);color:var(--on-maq)}
.on-tag.pc{border:1px solid var(--border);color:var(--text);font-weight:500;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
</head>
<body>
<div class="titlebar" id="titlebar">
  <div class="tb-left">
    <div class="tb-logo">CC</div>
    <span class="tb-title">Painel de Custos · Contas</span>
  </div>
  <div class="tb-actions">
    <button class="tb-btn" id="tb-min" title="Minimizar" aria-label="Minimizar">
      <svg viewBox="0 0 12 12" width="11" height="11"><rect x="1.5" y="5.5" width="9" height="1" fill="currentColor"/></svg>
    </button>
    <button class="tb-btn" id="tb-max" title="Maximizar" aria-label="Maximizar">
      <svg class="ic-max" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="1.7" y="1.7" width="8.6" height="8.6" rx="1"/></svg>
      <svg class="ic-restore" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="1.5" y="3" width="6.5" height="6.5" rx="1"/><path d="M4 3V1.7h6.3V8H9"/></svg>
    </button>
    <button class="tb-btn tb-close" id="tb-close" title="Fechar" aria-label="Fechar">
      <svg viewBox="0 0 12 12" width="11" height="11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>
    </button>
  </div>
</div>

<div id="login">
  <div class="login-card">
    <div class="logo" style="margin:0 auto 16px">CC</div>
    <h2><i data-lucide="lock"></i> Painel de Custos</h2>
    <p>Acesso restrito. Informe a senha de administrador.</p>
    <input id="senha" type="password" placeholder="Senha" autofocus />
    <button id="entrar">Entrar</button>
    <div class="login-err" id="login-err"></div>
  </div>
</div>

<div class="wrap hidden" id="app">
  <div class="topbar">
    <div class="brand"><div class="logo">CC</div><div class="name"><b>Contas Contabilidade</b><span>Custos de IA</span></div></div>
    <div class="spacer"></div>
    <span class="pill" id="atualizado">—</span>
    <button class="icon-btn" id="tema" title="Alternar tema"><i data-lucide="sun"></i><i data-lucide="moon"></i></button>
    <button class="icon-btn" id="refresh" title="Atualizar"><i data-lucide="refresh-cw"></i></button>
  </div>

  <h1>Custos de Inteligência Artificial</h1>
  <div class="sub" id="status">Consumo de IA (transcrição + resumo) e custo estimado.</div>

  <div class="seg" id="nav-view" style="margin:0 0 16px">
    <button data-v="custos" class="on"><i data-lucide="wallet"></i> Custos</button>
    <button data-v="feedback"><i data-lucide="message-square"></i> Feedback da IA</button>
    <button data-v="erros"><i data-lucide="triangle-alert"></i> Erros do app <span id="nav-erros-n" class="badge erro hidden">0</span></button>
    <button data-v="online"><i data-lucide="wifi"></i> Online <span id="nav-online-n" class="badge hidden">0</span></button>
  </div>

  <div id="view-custos">
  <div class="period">
    <div class="seg" id="seg-periodo">
      <button data-p="7d">7 dias</button>
      <button data-p="30d" class="on">30 dias</button>
      <button data-p="mes">Mês atual</button>
      <button data-p="tudo">Tudo</button>
      <button data-p="custom">Personalizado</button>
    </div>
    <span id="custom-range" class="hidden"><label>de</label> <input type="date" id="dt-de" /> <label>até</label> <input type="date" id="dt-ate" /></span>
    <div class="spacer"></div>
    <label>Câmbio R$</label> <input type="number" step="0.01" min="0" class="cambio" id="cambio" title="Vazio: cada dia usa o câmbio de fechamento daquele dia (hoje, a cotação atual). Com um valor: todos os dias usam este câmbio — só para simular." />
    <button class="mini-btn" id="csv-completo" title="CSV completo (todo o histórico, todas as seções)"><i data-lucide="file-text"></i> CSV completo</button>
    <button class="mini-btn" id="csv-periodo" title="CSV do período selecionado"><i data-lucide="file-text"></i> CSV período</button>
    <button class="mini-btn" id="xls-completo" title="Excel com abas (todo o histórico)"><i data-lucide="file-spreadsheet"></i> Excel completo</button>
    <button class="mini-btn" id="xls-periodo" title="Excel com abas (período selecionado)"><i data-lucide="file-spreadsheet"></i> Excel período</button>
    <button class="mini-btn" id="painel-nov" title="Novidades do painel de custos"><i data-lucide="sparkles"></i> Novidades</button>
  </div>

  <div class="cards">
    <div class="card accent"><div class="k"><i data-lucide="wallet"></i> Custo total (R$)</div><div class="v" id="c-brl">—</div><div class="s" id="c-brl-s"></div></div>
    <div class="card brand"><div class="k"><i data-lucide="dollar-sign"></i> Custo total (US$)</div><div class="v" id="c-usd">—</div><div class="s">preços de referência</div></div>
    <div class="card gold"><div class="k"><i data-lucide="trending-up"></i> Projeção do mês (R$)</div><div class="v" id="c-proj">—</div><div class="s" id="c-proj-s">no ritmo atual</div></div>
    <div class="card"><div class="k"><i data-lucide="hash"></i> Tokens (período)</div><div class="v" id="c-tok">—</div><div class="s" id="c-tok-s"></div></div>
    <div class="card"><div class="k"><i data-lucide="zap"></i> Chamadas de IA</div><div class="v" id="c-calls">—</div><div class="s">transcrição + resumo</div></div>
    <div class="card teal"><div class="k"><i data-lucide="mic"></i> Deepgram</div><div class="v" id="dg-cred">—</div><div class="s" id="dg-cred-s">créditos restantes</div></div>
    <div class="card brand"><div class="k"><i data-lucide="bot"></i> Claude (resumo)</div><div class="v" id="cl-saldo">—</div><div class="s" id="cl-saldo-s">saldo estimado do mês</div></div>
  </div>

  <div class="panel">
    <h3><i data-lucide="phone-call"></i> Por ligação (transcrição + resumo) — no período</h3>
    <div class="cards" style="grid-template-columns:repeat(3,1fr);margin-bottom:0">
      <div class="card brand"><div class="k"><i data-lucide="phone-call"></i> Ligações resumidas</div><div class="v" id="l-count">—</div><div class="s">com resumo da IA</div></div>
      <div class="card accent"><div class="k"><i data-lucide="wallet"></i> Custo total das ligações</div><div class="v" id="l-total">—</div><div class="s" id="l-total-s"></div></div>
      <div class="card gold"><div class="k"><i data-lucide="divide"></i> Custo médio por ligação</div><div class="v" id="l-avg">—</div><div class="s" id="l-avg-s">R$</div></div>
    </div>
  </div>

  <div class="grid2">
    <div class="panel" style="margin:0"><h3><i data-lucide="calendar-days"></i> Custo por dia (R$)</h3><div class="chart-box"><canvas id="chartCustoDia"></canvas></div></div>
    <div class="panel" style="margin:0"><h3><i data-lucide="mic"></i> Transcrição vs. resumo (R$)</h3><div class="chart-box"><canvas id="chartOp"></canvas></div></div>
  </div>

  <div class="grid2">
    <div class="panel" style="margin:0"><h3><i data-lucide="cpu"></i> Custo por modelo (R$)</h3><div class="chart-box"><canvas id="chartModelo"></canvas></div></div>
    <div class="panel" style="margin:0"><h3><i data-lucide="trending-up"></i> Tendência do custo médio por ligação (R$)</h3><div class="chart-box"><canvas id="chartTend"></canvas></div></div>
  </div>

  <div class="grid2">
    <div class="panel" style="margin:0"><h3><i data-lucide="layers"></i> Custo por fonte (R$)</h3><div class="chart-box"><canvas id="chartFonte"></canvas></div></div>
    <div class="panel" style="margin:0">
      <h3><i data-lucide="layers"></i> Por fonte — no período</h3>
      <div style="overflow:auto">
        <table>
          <thead><tr><th>Fonte</th><th class="right">Itens</th><th class="right">Custo R$</th><th class="right">%</th></tr></thead>
          <tbody id="tbody-fonte"><tr><td colspan="4" class="muted">—</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="grid2">
    <div class="panel" style="margin:0">
      <h3><i data-lucide="users"></i> Gasto por ramal / usuário — no período</h3>
      <div style="overflow:auto">
        <table>
          <thead><tr><th>Ramal</th><th>Usuário</th><th class="right">Ligações</th><th class="right">Custo R$</th></tr></thead>
          <tbody id="tbody-ramal"><tr><td colspan="4" class="muted">—</td></tr></tbody>
        </table>
      </div>
    </div>
    <div class="panel" style="margin:0"><h3><i data-lucide="flame"></i> Dias mais caros</h3><ul class="rank" id="ranking"><li class="muted">—</li></ul></div>
  </div>

  <div class="grid2">
    <div class="panel" style="margin:0">
      <h3><i data-lucide="building-2"></i> Custo por cliente — no período</h3>
      <div style="overflow:auto">
        <table>
          <thead><tr><th>Cliente</th><th class="right">Chamados</th><th class="right">Custo R$</th><th class="right">Média R$</th></tr></thead>
          <tbody id="tbody-cliente"><tr><td colspan="4" class="muted">—</td></tr></tbody>
        </table>
      </div>
    </div>
    <div class="panel" style="margin:0">
      <h3><i data-lucide="tag"></i> Custo por assunto — no período</h3>
      <div style="overflow:auto">
        <table>
          <thead><tr><th>Assunto</th><th class="right">Chamados</th><th class="right">Custo R$</th><th class="right">Média R$</th></tr></thead>
          <tbody id="tbody-assunto"><tr><td colspan="4" class="muted">—</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
  <div class="note" id="ch-aviso" style="margin:-6px 0 14px"></div>

  <div class="panel">
    <h3><i data-lucide="clock"></i> Uso por usuário — hoje</h3>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>Ramal</th><th>Usuário</th><th class="right">Chamadas</th><th class="right">Tokens</th><th class="right">Min (Deepgram)</th><th class="right">Custo R$</th></tr></thead>
        <tbody id="tbody-ramal-hoje"><tr><td colspan="6" class="muted">Carregando…</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h3><i data-lucide="ghost"></i> IA sem chamado — no período</h3>
    <div class="cards" style="grid-template-columns:repeat(3,1fr);margin-bottom:0">
      <div class="card accent"><div class="k"><i data-lucide="percent"></i> Não virou chamado</div><div class="v" id="sc-pct">—</div><div class="s" id="sc-pct-s">do gasto de IA no período</div></div>
      <div class="card gold"><div class="k"><i data-lucide="wallet"></i> Valor sem chamado</div><div class="v" id="sc-val">—</div><div class="s" id="sc-val-s">R$</div></div>
      <div class="card brand"><div class="k"><i data-lucide="flask-conical"></i> Testes (desenvolvimento)</div><div class="v" id="sc-teste">—</div><div class="s" id="sc-teste-s">fora do percentual</div></div>
    </div>
    <div class="chart-box" style="margin-top:14px"><canvas id="chartSemChamado"></canvas></div>
    <div style="overflow:auto;margin-top:10px">
      <table>
        <thead><tr><th>Ramal</th><th>Usuário</th><th class="right">Gasto R$</th><th class="right">Virou chamado R$</th><th class="right">Sem chamado R$</th><th class="right">%</th></tr></thead>
        <tbody id="tbody-semchamado"><tr><td colspan="6" class="muted">—</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h3><i data-lucide="table"></i> Custo por dia</h3>
    <div style="overflow:auto">
      <table>
        <thead><tr>
          <th class="sortable" data-col="dia">Dia</th>
          <th class="sortable right" data-col="tokens">Tokens</th>
          <th class="sortable right" data-col="calls">Chamadas</th>
          <th class="sortable right" data-col="ligacoes">Ligações</th>
          <th class="sortable right" data-col="audioSec">Min (Deepgram)</th>
          <th class="sortable right" data-col="custoBrl">Custo R$</th>
        </tr></thead>
        <tbody id="tbody-dia"><tr><td colspan="6" class="muted">Carregando…</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h3><i data-lucide="list"></i> Detalhe por modelo e operação (todo o período)</h3>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>Modelo</th><th>Operação</th><th class="right">Tokens entrada</th><th class="right">Tokens saída</th><th class="right">Chamadas</th><th class="right">Custo US$</th><th class="right">Custo R$</th></tr></thead>
        <tbody id="tbody"><tr><td colspan="7" class="muted">Carregando…</td></tr></tbody>
      </table>
    </div>
  </div>

  </div><!-- /view-custos -->

  <div id="view-feedback" class="hidden">
  <div class="panel">
    <h3><i data-lucide="message-square"></i> Feedback da IA</h3>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      <button class="mini-btn" id="fb-csv" title="Baixar em CSV (abre no Excel)"><i data-lucide="file-text"></i> Exportar CSV</button>
      <button class="mini-btn" id="fb-json" title="Baixar em JSON (dados brutos)"><i data-lucide="file-json"></i> Exportar JSON</button>
      <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);cursor:pointer" title="Mostra e exporta só o feedback do prompt em uso (ignora o dos prompts antigos)"><input type="checkbox" id="fb-so-atual" checked> Só do prompt atual</label>
    </div>
    <div id="fb-stats" class="muted" style="margin-bottom:12px">Carregando…</div>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>Data</th><th>Usuário</th><th>Fonte</th><th>Prompt</th><th>Avaliação</th><th>Divergências / tags</th><th>Comentário</th></tr></thead>
        <tbody id="tbody-feedback"><tr><td colspan="7" class="muted">Carregando…</td></tr></tbody>
      </table>
    </div>
  </div>
  </div><!-- /view-feedback -->

  <div id="view-erros" class="hidden">
  <div class="panel">
    <h3><i data-lucide="triangle-alert"></i> Erros do app (últimos 300)</h3>
    <div class="note">O app desktop reporta aqui o que quebra na máquina do usuário — mensagem, versão e contexto. Nunca envia transcrição, resumo nem conteúdo de e-mail.</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      <button class="mini-btn" id="er-csv" title="Baixar em CSV (abre no Excel)"><i data-lucide="file-text"></i> Exportar CSV</button>
      <button class="mini-btn" id="er-limpar" title="Apaga a lista depois de tratar os erros"><i data-lucide="trash-2"></i> Limpar lista</button>
      <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);cursor:pointer" title="Agrupa ocorrências iguais em vez de listar uma a uma"><input type="checkbox" id="er-agrupar" checked> Agrupar iguais</label>
    </div>
    <div id="er-stats" class="muted" style="margin-bottom:12px">Carregando…</div>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>Quando</th><th class="right">Vezes</th><th>Usuário</th><th>Versão</th><th>Origem</th><th>Contexto</th><th>Erro</th></tr></thead>
        <tbody id="tbody-erros"><tr><td colspan="7" class="muted">Carregando…</td></tr></tbody>
      </table>
    </div>
  </div>
  </div><!-- /view-erros -->

  <div id="view-online" class="hidden">
    <div class="on-status">
      <span class="pill" id="on-atualizado">Carregando…</span>
      <button class="mini-btn" id="on-refresh" title="Atualizar agora"><i data-lucide="refresh-cw"></i> Atualizar</button>
    </div>
    <div id="on-avisos"></div>
    <div class="on-top">
      <div class="panel on-resumo" id="on-resumo"><span class="muted">Carregando…</span></div>
      <div class="panel"><h3><i data-lucide="layers"></i> <span id="on-vers-tit">Versões de quem está online</span></h3><div class="on-vers" id="on-vers"></div></div>
    </div>
    <div id="on-alerta"></div>
    <div id="on-setores"></div>
    <div class="note"><b>Online</b> = app conectado ao aviso de ligações, mesmo minimizado na bandeja. <b>Versão</b> = a última que o app usou numa chamada ao servidor, anotada no máximo 1 vez por hora por pessoa (para poupar o Redis). Quem não tem conta Google só ganha versão quando usa o app (prévia, chamado, resumo). Setor vem do perfil de quem tem conta Google. Contorno tracejado = fora agora.</div>
  </div><!-- /view-online -->

  <!-- Novidades do painel de custos (changelog proprio; aparece ao acessar) -->
  <div id="nov-overlay" class="nov-ov hidden">
    <div class="nov-card">
      <div class="nov-h"><b><i data-lucide="sparkles"></i> Novidades do painel</b><button id="nov-x" title="Fechar"><i data-lucide="x"></i></button></div>
      <div id="nov-list" class="nov-l"></div>
      <div class="nov-f"><button class="mini-btn" id="nov-ok">Entendi</button></div>
    </div>
  </div>
</div>

<script>
// Desenha/redesenha os <i data-lucide> que ainda nao viraram <svg>. Precisa ser
// chamado depois de todo innerHTML que injeta icone (tabelas, novidades, KPIs).
function icones(){try{if(window.lucide&&lucide.createIcons)lucide.createIcons();}catch(e){}}

var THEME_KEY="painel-tema";
// O icone do botao (sol/lua) e trocado por CSS a partir do data-theme — nao
// mexer no conteudo aqui, senao apaga os <svg> ja renderizados pelo lucide.
function setTheme(t){document.documentElement.setAttribute("data-theme",t);try{localStorage.setItem(THEME_KEY,t)}catch(e){}}
setTheme((function(){try{return localStorage.getItem(THEME_KEY)||"dark"}catch(e){return "dark"}})());

// ---- Troca de tema com "agua" ----------------------------------------------
// Copia da animacao do app desktop (svgAgua e toggleTheme em
// renderer/app-core.js do conversor_WAV_txt), pedida para o painel em
// 06/11/2026. Os dois repositorios nao compartilham codigo: mudou la, mude aqui.
var TINTA_DURACAO_MS=1500;

// Centro do botao do sol/lua: e de la que a agua sai. Sem o botao visivel,
// sai do canto de cima a direita.
function origemDaTinta(){
  var b=document.getElementById("tema");
  var r=b&&b.getBoundingClientRect();
  if(r&&r.width)return {x:r.left+r.width/2,y:r.top+r.height/2};
  return {x:window.innerWidth-40,y:40};
}

// Mascara da troca de tema: uma poca d'agua que sai do botao e se espalha ate
// as bordas sem crescer por igual. Uma borda so ondulada parecia uma mancha
// sendo ampliada; o que da cara de agua sao os "dedos": filetes que escorrem na
// frente, cada um numa direcao e num momento, enquanto o resto da poca vem
// atras e preenche. A agua nunca recua: cada direcao guarda o maior raio que ja
// alcancou.
// Os quadros vao num <animate> do atributo "d" dentro do proprio SVG, sem
// filtro: filtro seria recalculado a cada quadro e engasgaria em PC fraco. O
// raio cresce como u^3: comeca devagar e acelera.
function svgAgua(W,H,bx,by){
  var PONTOS=120,QUADROS=30;
  var longe=Math.hypot(Math.max(bx,W-bx),Math.max(by,H-by));

  // Pseudo-aleatorio fixo: a mesma poca a cada troca (e a mesma do app), sem
  // Math.random. A ordem das chamadas a acaso() faz parte do desenho.
  var semente=11;
  function acaso(){semente=(semente*9301+49297)%233280;return semente/233280}
  var fases=[];
  for(var f=0;f<4;f++)fases.push(acaso()*Math.PI*2);

  // Dedos apontados para pontos sorteados DENTRO da janela: com o botao no
  // canto, um dedo sorteado em qualquer direcao poderia escorrer para fora da
  // tela e ninguem veria.
  var dedos=[];
  for(var j=0;j<8;j++){
    var alvoX=acaso()*W,alvoY=acaso()*H;
    dedos.push({
      angulo:Math.atan2(alvoY-by,alvoX-bx),
      finura:5+acaso()*25,     // maior = filete mais estreito
      altura:0.4+acaso()*0.7,  // quanto passa a frente da poca
      inicio:acaso()*0.6,      // quando comeca a escorrer (fracao do tempo)
      duracao:0.3+acaso()*0.4
    });
  }

  // A soma das amplitudes do contorno (0,27) e o quanto a borda pode ficar
  // para dentro do raio; o ultimo quadro compensa isso para cobrir os cantos,
  // com 5% de folga porque a curva passa um pouco por dentro dos pontos.
  var RECUO=0.27;
  var raioFinal=(longe/(1-RECUO))*1.05;
  function contorno(a,u){
    return 0.12*Math.sin(2*a+fases[0]+1.6*u)+
      0.09*Math.sin(3*a+fases[1]-2.2*u)+
      0.035*Math.sin(11*a+fases[2]+5*u)+
      0.025*Math.sin(17*a+fases[3]-6*u);
  }
  // Cada dedo nasce, chega ao comprimento maximo e "afunda" de volta na poca
  // (o maximo por direcao, la embaixo, impede que a borda recue).
  function dedosEm(a,u){
    var soma=0;
    for(var k=0;k<dedos.length;k++){
      var d=dedos[k],fase=(u-d.inicio)/d.duracao;
      if(fase<=0||fase>=1)continue;
      soma+=d.altura*Math.sin(Math.PI*fase)*Math.exp(d.finura*(Math.cos(a-d.angulo)-1));
    }
    return soma;
  }

  function meio(p,q){return [(p[0]+q[0])/2,(p[1]+q[1])/2]}
  function n(v){return v.toFixed(1)}
  var maiorRaio=[];
  for(var z=0;z<PONTOS;z++)maiorRaio.push(0);
  var valores=[],tempos=[];
  for(var q=0;q<=QUADROS;q++){
    var u=q/QUADROS,R=raioFinal*u*u*u,pts=[];
    for(var i=0;i<PONTOS;i++){
      var a=(i/PONTOS)*Math.PI*2;
      var r=Math.max(maiorRaio[i],R*(1+contorno(a,u)+dedosEm(a,u)));
      maiorRaio[i]=r;
      pts.push([bx+r*Math.cos(a),by+r*Math.sin(a)]);
    }
    // Curva fechada: passa pelo meio de cada lado, com o ponto como controle
    // (agua nao faz quina).
    var ini=meio(pts[PONTOS-1],pts[0]);
    var dd="M"+n(ini[0])+" "+n(ini[1]);
    for(var m=0;m<PONTOS;m++){
      var md=meio(pts[m],pts[(m+1)%PONTOS]);
      dd+="Q"+n(pts[m][0])+" "+n(pts[m][1])+" "+n(md[0])+" "+n(md[1]);
    }
    valores.push(dd+"Z");
    tempos.push(u.toFixed(4));
  }

  var dur=(TINTA_DURACAO_MS/1000).toFixed(2);
  // O <desc> com a hora faz cada troca ser uma imagem nova: imagem SVG repetida
  // reaproveitaria a animacao ja terminada e apareceria pronta. (O app usa um
  // comentario HTML; aqui o SVG mora dentro de um <script> e um comentario
  // HTML no meio do codigo confunde o leitor de HTML.)
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'">'+
    '<desc>'+Date.now()+'</desc>'+
    '<path d="'+valores[0]+'" fill="#000" stroke="#000" stroke-opacity="0.35" stroke-width="14" stroke-linejoin="round">'+
    '<animate attributeName="d" values="'+valores.join(";")+'" keyTimes="'+tempos.join(";")+'" dur="'+dur+'s" begin="0s" fill="freeze"/>'+
    '</path></svg>';
}

// Os graficos leem as cores do tema na hora de montar (Chart.js nao segue as
// variaveis CSS sozinho), entao trocar o tema e redesenhar andam juntos.
function trocarTema(t){setTheme(t);if(DADOS)render()}

document.getElementById("tema").onclick=function(){
  var root=document.documentElement;
  var next=root.getAttribute("data-theme")==="dark"?"light":"dark";

  // O navegador fotografa a tela no tema atual, o tema troca por baixo e o
  // novo aparece pela poca que sai do botao (mascara em
  // ::view-transition-new(root), lida da variavel --tinta). Sem a API
  // (navegador antigo), ou se a captura falhar, troca na hora, como antes.
  if(typeof document.startViewTransition==="function"){
    try{
      var o=origemDaTinta();
      var svg=svgAgua(window.innerWidth,window.innerHeight,o.x,o.y);
      root.style.setProperty("--tinta",'url("data:image/svg+xml,'+encodeURIComponent(svg)+'")');
      var transicao=document.startViewTransition(function(){trocarTema(next)});
      transicao.ready.then(function(){
        // A poca cresce dentro do SVG; esta animacao "parada" so segura a
        // transicao aberta ate ela cobrir a tela (sem ela, a transicao
        // acabaria na hora e ninguem veria a agua).
        root.animate({opacity:[1,1]},{duration:TINTA_DURACAO_MS+80,pseudoElement:"::view-transition-new(root)"});
      }).catch(function(e){
        // AbortError e transicao pulada (ex.: dois cliques seguidos): o tema
        // ja trocou. Qualquer outro erro (ex.: o redesenho dos graficos
        // quebrou) tem que aparecer no console.
        if(!e||e.name!=="AbortError")console.error("[tema] troca de tema com animacao falhou:",e);
      });
      transicao.finished.finally(function(){root.style.removeProperty("--tinta")}).catch(function(){/* o erro ja foi logado no ready */});
      return;
    }catch(e){
      console.warn("[tema] sem animacao de agua, troca direta:",e);
      root.style.removeProperty("--tinta");
    }
  }
  trocarTema(next);
};

// Abas: Custos x Feedback da IA x Erros do app x Online
var VIEWS=["custos","feedback","erros","online"];
(function(){var nav=document.getElementById("nav-view");if(!nav)return;var btns=nav.querySelectorAll("button");
  for(var i=0;i<btns.length;i++){btns[i].onclick=function(){
    var v=this.getAttribute("data-v");
    for(var j=0;j<btns.length;j++)btns[j].classList.toggle("on",btns[j]===this);
    for(var k=0;k<VIEWS.length;k++){var el=document.getElementById("view-"+VIEWS[k]);if(el)el.classList.toggle("hidden",VIEWS[k]!==v);}
    if(v==="feedback")carregarFeedback();
    if(v==="erros")carregarErros();
    if(v==="online")carregarOnline();
  };}})();

var fmtBRL=new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL",minimumFractionDigits:2,maximumFractionDigits:2});
var fmtBRL4=new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL",minimumFractionDigits:2,maximumFractionDigits:4});
var fmtInt=new Intl.NumberFormat("pt-BR");
function fmtUSD(v){return "US$ "+Number(v||0).toFixed(4)}

function senha(){try{return sessionStorage.getItem("admin-pwd")||""}catch(e){return ""}}
function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}

var DADOS=null;          // ultimo payload da API
var CAMBIO=null;         // override manual do cambio (null = usa o da API)
var PERIODO={preset:"30d",de:null,ate:null};
// ---- Paginacao das tabelas ----
// Estado por tabela; sobrevive ao re-render, entao trocar de filtro nao joga
// o usuario de volta para a pagina 1 sem necessidade.
var PAG={};
var PAG_TAM=10;
// Renderiza UMA pagina e desenha o controle logo abaixo da tabela/lista.
// Idempotente: pode ser chamada a cada render sem duplicar o controle.
function paginar(chave,alvo,itens,render,vazioHtml){
  if(!alvo)return;
  var total=itens.length;
  var pgs=Math.max(1,Math.ceil(total/PAG_TAM));
  var p=Math.min(Math.max(PAG[chave]||1,1),pgs);
  PAG[chave]=p;
  if(!total){alvo.innerHTML=vazioHtml;}
  else{var ini=(p-1)*PAG_TAM;alvo.innerHTML=itens.slice(ini,ini+PAG_TAM).map(render).join('');}
  // O controle vai depois da TABELA, nao dentro do tbody (que so aceita <tr>).
  var anexo=alvo.tagName==='TBODY'?(alvo.closest('table')||alvo):alvo;
  var id='pag-'+chave;
  var ctl=document.getElementById(id);
  if(!ctl){ctl=document.createElement('div');ctl.className='pag';ctl.id=id;anexo.insertAdjacentElement('afterend',ctl);}
  if(total<=PAG_TAM){ctl.innerHTML='';return;}
  var a1=(p-1)*PAG_TAM+1,a2=Math.min(p*PAG_TAM,total);
  ctl.innerHTML='<span>'+a1+'-'+a2+' de '+total+'</span>'+
    '<button data-a="prev"'+(p<=1?' disabled':'')+'>&lsaquo;</button>'+
    '<span>'+p+'/'+pgs+'</span>'+
    '<button data-a="next"'+(p>=pgs?' disabled':'')+'>&rsaquo;</button>';
  ctl.querySelector('[data-a="prev"]').onclick=function(){PAG[chave]=p-1;paginar(chave,alvo,itens,render,vazioHtml);};
  ctl.querySelector('[data-a="next"]').onclick=function(){PAG[chave]=p+1;paginar(chave,alvo,itens,render,vazioHtml);};
}
// Ordenar muda a ordem da lista: voltar para a pagina 1 evita o usuario ficar
// numa pagina do meio de uma lista que ja nao e a mesma.
function resetPag(chave){PAG[chave]=1;}

var ORD={col:"dia",dir:-1};
var timerAuto=null;

// Cambio de UM dia: o fechamento gravado no backend (nao muda mais) ou, para
// hoje e dia ainda sem fechamento, a cotacao atual. O campo "Cambio R$"
// preenchido vale para todos os dias — e simulacao, nao o custo de verdade.
function cotHoje(){return (DADOS&&DADOS.cotacao)||0}
function cotDia(dia){if(CAMBIO!=null)return CAMBIO;var h=DADOS&&DADOS.cotacoes,v=h&&h[dia];return v>0?v:cotHoje()}
// R$ de uma linha com dia (porDiaModelo, porRamal, porFonte, chamados). Somar
// em US$ e multiplicar uma vez so aplicaria um cambio ao periodo inteiro.
function brl(r){return (r.custoUsd||0)*cotDia(r.dia)}

// ---- datas (UTC, batendo com as chaves YYYY-MM-DD do backend) ----
function hojeUTC(){return new Date().toISOString().slice(0,10)}
function addDias(s,n){var d=new Date(s+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function diffDias(a,b){return Math.round((new Date(b+"T00:00:00Z")-new Date(a+"T00:00:00Z"))/86400000)}
function primeiroDiaMes(){return hojeUTC().slice(0,8)+"01"}
function ultimoDiaMes(){var d=new Date();return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()}
// --- base da projecao: DIAS UTEIS, nao dias corridos ---------------------
// O uso e de escritorio: sabado/domingo quase nao gastam. Dividir por dias
// corridos derrubava a media e subestimava a projecao.
function ehDiaUtil(s){var d=new Date(s+"T00:00:00Z").getUTCDay();return d>=1&&d<=5}
function diasUteisNoMes(){
  var base=primeiroDiaMes(),n=ultimoDiaMes(),c=0;
  for(var i=0;i<n;i++)if(ehDiaUtil(addDias(base,i)))c++;
  return c;
}
// Dias uteis ja decorridos, com o de HOJE valendo so a fracao ja vivida do dia
// (senao, de manha, a media diaria sai artificialmente baixa). Piso de 1 para
// nao explodir a projecao no comeco do mes, quando o denominador e minusculo.
function diasUteisDecorridos(){
  var hoje=hojeUTC(),base=primeiroDiaMes(),completos=0;
  for(var d=base;d<hoje;d=addDias(d,1))if(ehDiaUtil(d))completos++;
  var agora=new Date();
  var fracao=ehDiaUtil(hoje)?(agora.getUTCHours()+agora.getUTCMinutes()/60)/24:0;
  return Math.max(completos+fracao,1);
}
function minDia(){var xs=(DADOS&&DADOS.porDiaModelo||[]).map(function(x){return x.dia});return xs.length?xs.sort()[0]:hojeUTC()}
// Janela maxima das metricas que CRUZAM com a lista de chamados (custo por
// cliente, custo por assunto e IA sem chamado). A lista guarda os ultimos MAX
// (10 mil) chamados; olhar alem disso mostraria gasto cheio com chamados
// faltando — numeros errados sem aviso nenhum.
//
// NAO vale para o resto do painel: custo por dia, por ramal, por fonte e os
// totais saem do historico de gasto, que nunca expira. Travar tudo jogaria
// fora visibilidade que ja esta guardada e nao custa nada manter.
var LIMITE_MESES=2;
function limiteMinimo(){var d=new Date(hojeUTC()+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()-LIMITE_MESES);return d.toISOString().slice(0,10);}
function intervalo(){
  var ate=hojeUTC(),de;
  if(PERIODO.preset==="custom"){de=PERIODO.de||minDia();ate=PERIODO.ate||hojeUTC();}
  else if(PERIODO.preset==="7d")de=addDias(ate,-6);
  else if(PERIODO.preset==="30d")de=addDias(ate,-29);
  else if(PERIODO.preset==="mes")de=primeiroDiaMes();
  else de=minDia();
  if(de>ate){var t=de;de=ate;ate=t;}
  return {de:de,ate:ate};
}
// Recorta um intervalo para a janela coberta pela lista de chamados.
// Devolve tambem se houve corte, para o painel poder avisar em vez de mentir.
function intervaloChamados(iv){
  var min=limiteMinimo();
  var de=iv.de<min?min:iv.de;
  return {de:de,ate:iv.ate,cortado:iv.de<min};
}
function noPeriodo(rows,de,ate){return (rows||[]).filter(function(r){return r.dia>=de&&r.dia<=ate})}

// ---- agregacoes ----
// Quantas LIGACOES foram resumidas no periodo. Tem que sair de porFonte: o
// porDiaModelo nao carrega a fonte, entao contar op==="resumo" ali somava
// e-mail e chat junto — o card mostrava 90 quando eram 40 ligacoes, e o custo
// medio por ligacao saia diluido, contradizendo a tabela "Por fonte" ao lado.
function ligacoesNoPeriodo(de,ate){
  return noPeriodo(DADOS&&DADOS.porFonte||[],de,ate)
    .filter(function(r){return r.fonte==="ligacao"&&r.op==="resumo"})
    .reduce(function(a,r){return a+(r.calls||0)},0);
}
function totais(rows){var t={inputTokens:0,outputTokens:0,calls:0,custoUsd:0,custoBrl:0,ligacoes:0,transcUsd:0,resumoUsd:0,transcBrl:0,resumoBrl:0,audioSec:0,deepgramBrl:0,claudeBrl:0};
  rows.forEach(function(r){var b=brl(r);t.inputTokens+=r.inputTokens;t.outputTokens+=r.outputTokens;t.calls+=r.calls;t.custoUsd+=r.custoUsd;t.custoBrl+=b;t.audioSec+=r.audioSec||0;
    if(/^deepgram/i.test(r.model||""))t.deepgramBrl+=b;
    if(/^claude-/i.test(r.model||""))t.claudeBrl+=b;
    if(r.op==="resumo"){t.ligacoes+=r.calls;t.resumoUsd+=r.custoUsd;t.resumoBrl+=b}if(r.op==="transcricao"){t.transcUsd+=r.custoUsd;t.transcBrl+=b}});
  return t;}
function porDiaAgg(rows){var m={};
  rows.forEach(function(r){var a=m[r.dia]||(m[r.dia]={dia:r.dia,inputTokens:0,outputTokens:0,calls:0,ligacoes:0,custoUsd:0,custoBrl:0,audioSec:0});
    a.inputTokens+=r.inputTokens;a.outputTokens+=r.outputTokens;a.calls+=r.calls;a.custoUsd+=r.custoUsd;a.custoBrl+=brl(r);a.audioSec+=r.audioSec||0;if(r.op==="resumo")a.ligacoes+=r.calls});
  return Object.keys(m).sort().map(function(k){return m[k]});}
function ramalAgg(rows){var m={};
  rows.forEach(function(r){var a=m[r.ramal]||(m[r.ramal]={ramal:r.ramal,usuario:r.usuario||"",calls:0,ligacoes:0,custoUsd:0,custoBrl:0,audioSec:0,tokens:0});
    a.calls+=r.calls;a.custoUsd+=r.custoUsd;a.custoBrl+=brl(r);a.audioSec+=r.audioSec||0;a.tokens+=(r.inputTokens||0)+(r.outputTokens||0);if(r.op==="resumo")a.ligacoes+=r.calls;if(!a.usuario&&r.usuario)a.usuario=r.usuario});
  return Object.keys(m).map(function(k){return m[k]}).sort(function(a,b){return b.custoBrl-a.custoBrl});}

async function carregar(){
  var r,d;
  try{ r=await fetch("/api/admin/uso",{headers:{Authorization:"Bearer "+senha()}}); }
  catch(e){ document.getElementById("status").textContent="Falha de rede."; return; }
  if(r.status===401){ mostrarLogin("Senha incorreta."); return; }
  // Um 500 devolve HTML: com o r.json() fora do try o erro virava
  // unhandledrejection e o painel ficava eternamente em "Carregando...".
  if(!r.ok){ document.getElementById("status").textContent="Falha ao carregar (HTTP "+r.status+")."; return; }
  try{ d=await r.json(); }
  catch(e){ document.getElementById("status").textContent="Resposta invalida do servidor."; return; }
  DADOS=d;
  document.getElementById("login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  // Vazio = cambio de cada dia. A cotacao de hoje fica so de dica: escrita no
  // campo, parecia valer para o periodo inteiro.
  var ci=document.getElementById("cambio");if(ci)ci.placeholder=Number(d.cotacao||0).toFixed(2);
  if(!d.configurado){document.getElementById("status").textContent="Storage (Upstash) ainda não configurado — os contadores começam a somar após configurar.";}
  else{document.getElementById("status").textContent="Consumo de IA (transcrição + resumo) e custo estimado.";}
  var agora=new Date();
  document.getElementById("atualizado").textContent="atualizado "+String(agora.getHours()).padStart(2,"0")+":"+String(agora.getMinutes()).padStart(2,"0");
  render();
  carregarFeedback();
  carregarErros(); // mantem o contador de erros da aba sempre atual
  carregarOnline(); // idem, o numero de quem esta online na aba
  checarNovidadesPainel();
}

// ---- Novidades do painel de custos (changelog proprio, so deste painel) ----
// Bump PAINEL_NOV_VER quando adicionar novidades -> reaparece 1x ao acessar.
var PAINEL_NOV_VER="2026-11b";
// ic = nome do icone no lucide (mesma biblioteca do app).
var PAINEL_NOV=[
  {ic:"wifi",tx:"Aba <b>Online</b>: quem está com o app aberto agora, separado por setor, com a <b>versão</b> de cada um e a lista de quem <b>precisa atualizar</b>. A versão começa a aparecer conforme cada pessoa usa o app."},
  {ic:"banknote",tx:"Os valores em <b>R$</b> agora usam o <b>câmbio de fechamento de cada dia</b>: quando o dólar mexe, os dias que já passaram não mudam mais. Hoje usa a cotação atual. O campo <b>Câmbio R$</b> vazio segue o câmbio de cada dia; com um valor, simula todos os dias com ele."},
  {ic:"bot",tx:"O resumo agora é feito pelo <b>Claude Haiku 5.5</b> (o Gemini fica de reserva). Novo cartão <b>Claude</b> com o <b>saldo estimado do mês</b> — a Anthropic não informa saldo, então é a franquia menos o gasto registrado aqui."},
  {ic:"file-text",tx:"Novos <b>Relatório completo</b> e <b>Relatório do período</b> (CSV) com todas as seções: resumo geral, por dia, por ramal, por fonte, por modelo e transcrição × resumo."},
  {ic:"file-spreadsheet",tx:"Exportação em <b>Excel com abas</b> (uma aba por seção), com números de verdade — dá pra somar e ordenar."},
  {ic:"calendar-days",tx:"Seção <b>Por mês</b>: comparativo mês a mês com variação % em relação ao mês anterior."},
  {ic:"message-square",tx:"Aba <b>Feedback da IA</b> com exportação em <b>CSV/JSON</b> e estatísticas (positivo/negativo, divergências, tags)."},
  {ic:"type",tx:"Correção de <b>acentos</b> nos arquivos exportados (abrem certinho no Excel, sem “Ã§”)."},
  {ic:"palette",tx:"Painel com os <b>mesmos ícones do aplicativo</b> (Lucide), no lugar dos emojis."},
  {ic:"building-2",tx:"Novas tabelas <b>Custo por cliente</b> e <b>Custo por assunto</b> (também nos relatórios). Conta a partir de agora — só os chamados criados daqui pra frente."},
  {ic:"triangle-alert",tx:"Aba <b>Erros do app</b>: o que quebra na máquina do usuário aparece aqui, agrupado, sem depender de ninguém avisar."},
  {ic:"trending-up",tx:"<b>Projeção do mês</b> agora usa <b>dias úteis</b> (e conta hoje pela fração já decorrida) em vez de dias corridos."}
];
function renderNovidadesPainel(){
  var l=document.getElementById("nov-list");
  if(l)l.innerHTML=PAINEL_NOV.map(function(n){return '<div class="nov-it"><span class="em"><i data-lucide="'+n.ic+'"></i></span><span class="tx">'+n.tx+'</span></div>';}).join("");
  icones();
}
function abrirNovidadesPainel(){renderNovidadesPainel();var o=document.getElementById("nov-overlay");if(o)o.classList.remove("hidden");}
function fecharNovidadesPainel(){var o=document.getElementById("nov-overlay");if(o)o.classList.add("hidden");}
function checarNovidadesPainel(){
  var seen="";try{seen=localStorage.getItem("painel-novidades-visto")||"";}catch(e){}
  if(seen!==PAINEL_NOV_VER){abrirNovidadesPainel();try{localStorage.setItem("painel-novidades-visto",PAINEL_NOV_VER);}catch(e){}}
}

function escFb(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
var FEEDBACK=[]; // ultimo lote carregado (usado na exportacao)
// Versao do prompt em uso (carimbada em cada feedback). Injetada pelo servidor.
var PROMPT_VERSION_ATUAL=${JSON.stringify(PROMPT_VERSION)};
// Lista visivel/exportada: respeita o filtro "Só do prompt atual".
function feedbackVisiveis(){
  var cb=document.getElementById("fb-so-atual");
  if(cb&&cb.checked){return FEEDBACK.filter(function(f){return (f.promptVersion||"")===PROMPT_VERSION_ATUAL;});}
  return FEEDBACK;
}
async function carregarFeedback(){
  var tb=document.getElementById("tbody-feedback");
  try{
    var r=await fetch("/api/admin/feedback",{headers:{Authorization:"Bearer "+senha()}});
    if(!r.ok){ if(tb)tb.innerHTML='<tr><td colspan="7" class="muted">Falha ao carregar feedback.</td></tr>'; return; }
    var d=await r.json();
    FEEDBACK=(d&&d.itens)||[];
    renderFeedback(feedbackVisiveis());
  }catch(e){ if(tb)tb.innerHTML='<tr><td colspan="7" class="muted">Falha de rede.</td></tr>'; }
}

// ---- Exportacao (CSV para Excel / JSON bruto) ----
// Usa o lote ja carregado no navegador; nao envia nada pro servidor.
function csvCampo(v){var s=String(v==null?"":v);return /[";\\n\\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
function baixarArquivo(conteudo,tipo,nome){
  var blob=new Blob([conteudo],{type:tipo});
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a");
  a.href=url;a.download=nome;document.body.appendChild(a);a.click();
  document.body.removeChild(a);
  setTimeout(function(){URL.revokeObjectURL(url);},1000);
}
function exportarFeedback(fmt){
  var itens=feedbackVisiveis();
  if(!itens.length){alert("Sem feedback para exportar.");return;}
  var hoje=new Date().toISOString().slice(0,10);
  if(fmt==="json"){
    baixarArquivo("\\ufeff"+JSON.stringify(itens,null,2),"application/json;charset=utf-8","feedback-ia-"+hoje+".json");
    return;
  }
  // CSV com ";" e BOM: e o que o Excel pt-BR abre certinho (acentos inclusive).
  var cols=["Data","PromptVersao","Tipo","Origem","Usuario","Ramal","Modelo","Avaliacao","Tags","Comentario",
    "DescricaoEditada","IA_OK","ClienteMudou","ClienteTinhaSugestao","ClienteVia",
    "AssuntoMudou","AssuntoSugerido","AssuntoFinal",
    "SetorMudou","ExecutorMudou","Id"];
  var linhas=[cols.join(";")];
  itens.forEach(function(f){
    var dv=f.divergencias||{};
    var data="";try{data=new Date(f.ts).toLocaleString("pt-BR");}catch(e){data=f.ts||"";}
    linhas.push([data,f.promptVersion||"",f.tipo||"",f.origem||"",f.usuario||"",f.ramal||"",f.modelo||"",
      f.rating||"",(f.tags||[]).join(", "),f.comentario||"",
      f.descEditada?"sim":"nao",f.iaOk===false?"nao":"sim",
      dv.clienteMudou?"sim":"nao",dv.clienteTinhaSugestao?"sim":"nao",dv.clienteVia||"",
      dv.assuntoMudou?"sim":"nao",
      dv.assuntoSugerido||"",dv.assuntoFinal||"",
      dv.setorMudou?"sim":"nao",dv.executorMudou?"sim":"nao",f.id||""
    ].map(csvCampo).join(";"));
  });
  baixarArquivo("\\ufeff"+linhas.join("\\r\\n"),"text/csv;charset=utf-8","feedback-ia-"+hoje+".csv");
}
(function(){
  var c=document.getElementById("fb-csv"); if(c)c.onclick=function(){exportarFeedback("csv");};
  var j=document.getElementById("fb-json"); if(j)j.onclick=function(){exportarFeedback("json");};
  var cb=document.getElementById("fb-so-atual"); if(cb)cb.onchange=function(){renderFeedback(feedbackVisiveis());};
})();
function renderFeedback(itens){
  var st=document.getElementById("fb-stats");
  var tb=document.getElementById("tbody-feedback");
  // Resumo por versao de prompt (sempre sobre TODO o lote, ignora o filtro).
  var doAtual=FEEDBACK.filter(function(f){return (f.promptVersion||"")===PROMPT_VERSION_ATUAL;}).length;
  var verInfo="Prompt atual: <b>"+escFb(PROMPT_VERSION_ATUAL)+"</b> · <b>"+doAtual+"</b> de "+FEEDBACK.length+" feedbacks são deste prompt";
  if(!itens.length){ if(st)st.innerHTML=verInfo+" · sem itens para exibir."; if(tb)tb.innerHTML='<tr><td colspan="7" class="muted">Sem feedback para o filtro atual.</td></tr>'; return; }
  var up=0,down=0,editada=0,implic=0,dvC=0,dvA=0,dvS=0,dvE=0,tagCount={};
  // Cliente tem DOIS modos de falha que nao devem ser somados no mesmo numero:
  // errou (tinha sugestao e o usuario trocou) x nao achou (nao veio sugestao).
  var cliComSug=0,cliErrou=0,cliSemSug=0;
  itens.forEach(function(f){
    if(f.rating==="up")up++; if(f.rating==="down")down++;
    if(f.descEditada)editada++;
    if(f.tipo==="implicito"){implic++;var dv=f.divergencias||{};
      if(dv.clienteMudou)dvC++; if(dv.assuntoMudou)dvA++; if(dv.setorMudou)dvS++; if(dv.executorMudou)dvE++;
      // Campo novo (2026-07-30): feedback antigo nao tem, entao so conta quem tem.
      if(dv.clienteTinhaSugestao===true){cliComSug++;if(dv.clienteMudou)cliErrou++;}
      else if(dv.clienteTinhaSugestao===false)cliSemSug++;}
    (f.tags||[]).forEach(function(t){tagCount[t]=(tagCount[t]||0)+1;});
  });
  var pct=function(n,d){return d>0?Math.round(n/d*100)+"%":"—";};
  var topTags=Object.keys(tagCount).sort(function(a,b){return tagCount[b]-tagCount[a];}).slice(0,4)
    .map(function(t){return escFb(t)+" ("+tagCount[t]+")";}).join(", ")||"—";
  var detalheCliente=(cliComSug+cliSemSug)>0
    ? " <span class='muted'>(destes: errou "+pct(cliErrou,cliComSug)+" dos "+cliComSug
      +" com sugestão · sem sugestão em "+cliSemSug+")</span>"
    : "";
  if(st){st.innerHTML=verInfo+"<br><b>"+itens.length+"</b> exibidos · <span class='av-up'><i data-lucide='thumbs-up'></i></span> <b>"+up+"</b> · <span class='av-down'><i data-lucide='thumbs-down'></i></span> <b>"+down+"</b> · descrição editada em <b>"+pct(editada,itens.length)+"</b> · divergência (dos "+implic+" implícitos): cliente "+pct(dvC,implic)+detalheCliente+", assunto "+pct(dvA,implic)+", setor "+pct(dvS,implic)+", executor "+pct(dvE,implic)+" · tags: "+topTags;}
  if(tb){tb.innerHTML=itens.map(function(f){
    var data="";try{data=new Date(f.ts).toLocaleString("pt-BR");}catch(e){data=escFb(f.ts);}
    var aval=f.rating==="up"?"<span class='av-up'><i data-lucide='thumbs-up'></i></span>"
      :(f.rating==="down"?"<span class='av-down'><i data-lucide='thumbs-down'></i></span>"
      :(f.tipo==="implicito"?"(implícito)":"—"));
    var pv=f.promptVersion||"—";
    var pvCell=(f.promptVersion&&f.promptVersion!==PROMPT_VERSION_ATUAL)?'<span title="prompt antigo" style="color:var(--muted)">'+escFb(pv)+'</span>':escFb(pv);
    var dv=f.divergencias||{};var divs=[];
    if(dv.assuntoMudou)divs.push("assunto: "+escFb(dv.assuntoSugerido||"?")+" → "+escFb(dv.assuntoFinal||"?"));
    if(dv.clienteMudou)divs.push(dv.clienteTinhaSugestao===false
      ? "cliente: <b>não sugerido</b> (usuário escolheu)"
      : "cliente trocado"+(dv.clienteVia?" (veio de "+escFb(dv.clienteVia)+")":""));
    if(dv.setorMudou)divs.push("setor trocado");
    if(dv.executorMudou)divs.push("executor trocado");
    if(f.descEditada)divs.push("descrição editada");
    (f.tags||[]).forEach(function(t){divs.push(escFb(t));});
    return "<tr><td>"+escFb(data)+"</td><td>"+escFb(f.usuario||f.ramal||"—")+"</td><td>"+escFb(f.origem||"—")+"</td><td>"+pvCell+"</td><td>"+aval+"</td><td>"+(divs.join("; ")||"—")+"</td><td>"+escFb(f.comentario||"")+"</td></tr>";
  }).join("");}
  icones(); // avaliacoes e stats sao <i data-lucide> recem-injetados
}

// ---- Erros do app (telemetria do desktop) --------------------------------
var ERROS=[];
function chaveErro(e){return (e.mensagem||"")+"||"+(e.contexto||"")+"||"+(e.versao||"");}
// Agrupa ocorrencias iguais (mesma mensagem+contexto+versao): 1 linha com o
// numero de vezes e a ocorrencia mais recente. Sem isso, um erro em loop na
// maquina de um usuario empurra todo o resto da lista pra fora da tela.
function agruparErros(itens){
  var m={},ordem=[];
  itens.forEach(function(e){
    var k=chaveErro(e),a=m[k];
    if(!a){a=m[k]={ex:e,vezes:0,usuarios:{},ultimo:e.ts,primeiro:e.ts};ordem.push(k);}
    a.vezes++;
    if(e.usuario||e.ramal)a.usuarios[e.usuario||e.ramal]=1;
    if(e.ts>a.ultimo)a.ultimo=e.ts;
    if(e.ts<a.primeiro)a.primeiro=e.ts;
  });
  return ordem.map(function(k){return m[k];}).sort(function(a,b){return a.ultimo<b.ultimo?1:-1;});
}
async function carregarErros(){
  var tb=document.getElementById("tbody-erros");
  try{
    var r=await fetch("/api/admin/erros",{headers:{Authorization:"Bearer "+senha()}});
    if(!r.ok){ if(tb)tb.innerHTML='<tr><td colspan="7" class="muted">Falha ao carregar os erros.</td></tr>'; return; }
    var d=await r.json();
    ERROS=(d&&d.itens)||[];
    renderErros();
  }catch(e){ if(tb)tb.innerHTML='<tr><td colspan="7" class="muted">Falha de rede.</td></tr>'; }
}
function dataBR(ts){try{return new Date(ts).toLocaleString("pt-BR");}catch(e){return ts||"";}}
function renderErros(){
  var st=document.getElementById("er-stats"),tb=document.getElementById("tbody-erros");
  var nav=document.getElementById("nav-erros-n");
  // Badge na aba: so conta o que aconteceu nas ultimas 24h (o resto e historico).
  var limite=new Date(Date.now()-24*3600*1000).toISOString();
  var recentes=ERROS.filter(function(e){return (e.ts||"")>=limite;}).length;
  if(nav){nav.textContent=recentes;nav.classList.toggle("hidden",recentes===0);}
  if(!ERROS.length){
    if(st)st.innerHTML="Nenhum erro reportado pelos apps.";
    if(tb)tb.innerHTML='<tr><td colspan="7" class="muted">Nenhum erro reportado pelos apps.</td></tr>';
    return;
  }
  var usuarios={},versoes={};
  ERROS.forEach(function(e){if(e.usuario||e.ramal)usuarios[e.usuario||e.ramal]=1;if(e.versao)versoes[e.versao]=1;});
  var grupos=agruparErros(ERROS);
  if(st){st.innerHTML="<b>"+ERROS.length+"</b> ocorrências · <b>"+grupos.length+"</b> erros distintos · <b>"+recentes
    +"</b> nas últimas 24h · usuários afetados: <b>"+Object.keys(usuarios).length+"</b> · versões: "+(Object.keys(versoes).join(", ")||"—");}
  var agrupar=document.getElementById("er-agrupar");
  var linhas;
  if(!agrupar||agrupar.checked){
    linhas=grupos.map(function(g){
      var e=g.ex;
      return "<tr><td>"+escFb(dataBR(g.ultimo))+"</td><td class='right'>"+g.vezes+"</td><td>"+escFb(Object.keys(g.usuarios).join(", ")||"—")
        +"</td><td>"+escFb(e.versao||"—")+"</td><td>"+escFb(e.origem||"—")+"</td><td>"+escFb(e.contexto||"—")+"</td><td>"+celErro(e)+"</td></tr>";
    });
  }else{
    linhas=ERROS.map(function(e){
      return "<tr><td>"+escFb(dataBR(e.ts))+"</td><td class='right'>1</td><td>"+escFb(e.usuario||e.ramal||"—")
        +"</td><td>"+escFb(e.versao||"—")+"</td><td>"+escFb(e.origem||"—")+"</td><td>"+escFb(e.contexto||"—")+"</td><td>"+celErro(e)+"</td></tr>";
    });
  }
  if(tb)tb.innerHTML=linhas.join("");
  icones();
}
function celErro(e){
  var msg="<span class='er-msg'>"+escFb(e.mensagem||"")+"</span>";
  if(!e.stack)return msg;
  return msg+"<details class='er-det'><summary>stack</summary><pre>"+escFb(e.stack)+"</pre></details>";
}
function exportarErros(){
  if(!ERROS.length){alert("Sem erros para exportar.");return;}
  var cols=["Data","Origem","Tipo","Versao","Usuario","Ramal","Contexto","Plataforma","Mensagem","Stack"];
  var L=[cols.join(";")];
  ERROS.forEach(function(e){
    L.push([dataBR(e.ts),e.origem||"",e.tipo||"",e.versao||"",e.usuario||"",e.ramal||"",e.contexto||"",
      e.plataforma||"",e.mensagem||"",(e.stack||"").replace(/\\r?\\n/g," | ")].map(csvCampo).join(";"));
  });
  baixarArquivo("\\ufeff"+L.join("\\r\\n"),"text/csv;charset=utf-8","erros-app-"+hojeUTC()+".csv");
}
async function limparListaErros(){
  if(!confirm("Apagar a lista de erros? Isso é permanente."))return;
  try{
    var r=await fetch("/api/admin/erros/limpar",{method:"POST",headers:{Authorization:"Bearer "+senha()}});
    if(!r.ok){alert("Não foi possível limpar.");return;}
    ERROS=[];renderErros();
  }catch(e){alert("Falha de rede.");}
}
(function(){
  var c=document.getElementById("er-csv"); if(c)c.onclick=exportarErros;
  var l=document.getElementById("er-limpar"); if(l)l.onclick=limparListaErros;
  var g=document.getElementById("er-agrupar"); if(g)g.onchange=renderErros;
})();

function render(){
  if(!DADOS)return;
  var iv=intervalo();
  var rowsP=noPeriodo(DADOS.porDiaModelo,iv.de,iv.ate);
  var t=totais(rowsP);
  t.ligacoes=ligacoesNoPeriodo(iv.de,iv.ate);

  // KPIs
  document.getElementById("c-brl").textContent=fmtBRL.format(t.custoBrl);
  document.getElementById("c-usd").textContent=fmtUSD(t.custoUsd);
  document.getElementById("c-tok").textContent=fmtInt.format(t.inputTokens+t.outputTokens);
  document.getElementById("c-tok-s").textContent=fmtInt.format(t.inputTokens)+" in · "+fmtInt.format(t.outputTokens)+" out";
  document.getElementById("c-calls").textContent=fmtInt.format(t.calls);

  // Comparativo vs periodo anterior de mesmo tamanho (#3)
  var nDias=diffDias(iv.de,iv.ate)+1;
  var antAte=addDias(iv.de,-1),antDe=addDias(antAte,-(nDias-1));
  var custoAnt=totais(noPeriodo(DADOS.porDiaModelo,antDe,antAte)).custoBrl;
  var custoAtual=t.custoBrl;
  var brlS=CAMBIO!=null
    ? '<span class="delta up">câmbio fixo R$ '+Number(CAMBIO).toFixed(2)+' (simulação)</span>'
    : "câmbio de cada dia · hoje R$ "+Number(cotHoje()).toFixed(2);
  // Busca do historico falhando: os dias sem fechamento estao na cotacao de hoje.
  var cd=DADOS.cambioDia;
  if(cd&&cd.falhaDesde)brlS+=' · <span class="delta up" title="'+escXml(cd.motivoFalha||"")+'">câmbio histórico indisponível desde '+new Date(cd.falhaDesde).toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})+'</span>';
  if(custoAnt>0){var delta=(custoAtual-custoAnt)/custoAnt*100;var up=delta>=0;
    brlS+=' · <span class="delta '+(up?"up":"down")+'"><i data-lucide="'+(up?"trending-up":"trending-down")+'"></i> '+Math.abs(delta).toFixed(0)+"% vs período anterior</span>";}
  document.getElementById("c-brl-s").innerHTML=brlS;

  // Card do Deepgram: créditos restantes (destaque) + uso do período (sub).
  var dgCred=document.getElementById("dg-cred"),dgSub=document.getElementById("dg-cred-s");
  var temSaldo=DADOS&&typeof DADOS.deepgramSaldoUsd==='number';
  if(dgCred)dgCred.textContent=temSaldo?("US$ "+DADOS.deepgramSaldoUsd.toFixed(2).replace(".",",")):"—";
  if(dgSub)dgSub.innerHTML=fmtInt.format(Math.round((t.audioSec||0)/60))+" min · "+fmtBRL.format(t.deepgramBrl||0)+" no período"+(temSaldo?"":" · saldo indisponível");

  // Card do Claude: saldo ESTIMADO do mes (a Anthropic nao tem API de saldo;
  // o backend calcula franquia - gasto registrado aqui) + uso do periodo.
  var clSaldo=document.getElementById("cl-saldo"),clSub=document.getElementById("cl-saldo-s");
  var cs=DADOS&&DADOS.claudeSaldo;
  if(clSaldo){clSaldo.textContent=cs?("US$ "+cs.saldoEstimadoUsd.toFixed(2).replace(".",",")):"—";
    clSaldo.title=cs?("Estimado: franquia de US$ "+cs.creditoMensalUsd+" menos o gasto em Claude registrado por este backend no mês ("+fmtUSD(cs.gastoMesUsd)+"). Uso da mesma conta fora do backend não entra."):"";}
  // Preco do Claude conferido em claude.com/pricing (1x/dia). Falha de leitura
  // aparece aqui em destaque: o painel segue no ultimo preco lido.
  var cp=DADOS&&DADOS.claudePreco;
  var diaMes=function(iso){return new Date(iso).toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})};
  var precoTx="";
  if(cp){
    if(cp.falhaDesde)precoTx=' · <span class="delta up">preço não conferido desde '+diaMes(cp.falhaDesde)+'</span>';
    else if(cp.verificadoEm)precoTx=" · preço conferido "+diaMes(cp.verificadoEm);
    else precoTx=" · preço da tabela do código";
    if(clSaldo)clSaldo.title+="\\n\\nPreço: US$ "+cp.input+" entrada / US$ "+cp.output+" saída por milhão de tokens (prompt acima de 100 mil: "+cp.inputLongo+" / "+cp.outputLongo+"). "+
      (cp.fonte==="site"?"Lido de claude.com/pricing":"Tabela do código (site ainda não lido)")+
      (cp.verificadoEm?", conferido em "+new Date(cp.verificadoEm).toLocaleString("pt-BR")+".":".")+
      (cp.falhaDesde?"\\nLeitura do site falhando desde "+new Date(cp.falhaDesde).toLocaleString("pt-BR")+": "+(cp.motivoFalha||""):"");
  }
  if(clSub)clSub.innerHTML="saldo estimado do mês · "+fmtBRL.format(t.claudeBrl||0)+" no período"+precoTx;

  // Projecao do mes (#4) — media por DIA UTIL decorrido x dias uteis do mes.
  var mesDe=primeiroDiaMes(),mesAte=hojeUTC();
  var custoMes=totais(noPeriodo(DADOS.porDiaModelo,mesDe,mesAte)).custoBrl;
  var uteisDec=diasUteisDecorridos(),uteisMes=diasUteisNoMes();
  var proj=custoMes/uteisDec*uteisMes;
  document.getElementById("c-proj").textContent=fmtBRL.format(proj);
  var projS=document.getElementById("c-proj-s");
  projS.textContent="mês até agora: "+fmtBRL.format(custoMes)+" · "+fmtBRL4.format(custoMes/uteisDec)+"/dia útil";
  projS.title="Projeção = (gasto do mês ÷ "+uteisDec.toFixed(1)+" dias úteis decorridos) × "
    +uteisMes+" dias úteis do mês. O dia de hoje entra pela fração já decorrida (UTC).";

  // Por ligacao (periodo)
  var custoLig=t.transcBrl+t.resumoBrl;
  document.getElementById("l-count").textContent=fmtInt.format(t.ligacoes);
  document.getElementById("l-total").textContent=fmtBRL.format(custoLig);
  document.getElementById("l-total-s").textContent=fmtUSD(t.transcUsd+t.resumoUsd);
  document.getElementById("l-avg").textContent=fmtBRL4.format(t.ligacoes?custoLig/t.ligacoes:0);
  document.getElementById("l-avg-s").textContent=(t.ligacoes?fmtUSD((t.transcUsd+t.resumoUsd)/t.ligacoes):fmtUSD(0))+" / ligação";

  var accent=css("--accent"),brand=css("--brand-2"),gold=css("--gold"),muted=css("--muted"),grid="rgba(120,140,180,.14)";
  var dias=porDiaAgg(rowsP);

  // #2 Custo por dia (R$)
  chart("chartCustoDia",{type:"bar",data:{labels:dias.map(function(x){return x.dia.slice(5)}),datasets:[{data:dias.map(function(x){return +x.custoBrl.toFixed(4)}),backgroundColor:accent,borderRadius:6}]},options:baseOpt(muted,grid,true)});

  // #6 Transcricao vs resumo (rosca, R$)
  chart("chartOp",{type:"doughnut",data:{labels:["Transcrição","Resumo"],datasets:[{data:[+t.transcBrl.toFixed(4),+t.resumoBrl.toFixed(4)],backgroundColor:[brand,gold],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:muted}}}}});

  // Custo por modelo (R$) no periodo
  var porModelo={};rowsP.forEach(function(r){porModelo[r.model]=(porModelo[r.model]||0)+brl(r)});
  var ml=Object.keys(porModelo).sort(function(a,b){return porModelo[b]-porModelo[a]});
  chart("chartModelo",{type:"bar",data:{labels:ml,datasets:[{data:ml.map(function(m){return +porModelo[m].toFixed(4)}),backgroundColor:brand,borderRadius:6}]},options:baseOpt(muted,grid,false)});

  // #9 Tendencia custo medio por ligacao
  chart("chartTend",{type:"line",data:{labels:dias.map(function(x){return x.dia.slice(5)}),datasets:[{label:"R$ / ligação",data:dias.map(function(x){return x.ligacoes?+(x.custoBrl/x.ligacoes).toFixed(4):0}),borderColor:gold,backgroundColor:"rgba(224,169,59,.15)",fill:true,tension:.3}]},options:baseOpt(muted,grid,false)});

  // Ligacoes vs E-mails (por fonte)
  var fonteRows=noPeriodo(DADOS.porFonte,iv.de,iv.ate);
  var fAgg={};
  fonteRows.forEach(function(r){var a=fAgg[r.fonte]||(fAgg[r.fonte]={custoBrl:0,itens:0});a.custoBrl+=brl(r);if(r.op==="resumo")a.itens+=r.calls;});
  // Fontes do painel. Tabela unica: incluir uma fonte nova aqui ja reflete no
  // grafico, na tabela e no total — antes o Chat era gravado mas nao aparecia.
  // Cores bem separadas no circulo cromatico: verde (ligacao), ambar (e-mail),
  // roxo (chat) e magenta (resumo). O antigo #2f9e6b era quase o mesmo verde do
  // --accent das ligacoes e as duas fatias se confundiam no grafico.
  // Triagem (marrom) = conferencia da caixa do Gmail no piloto das sugestoes.
  var FONTES=[["Ligações","ligacao",accent],["E-mails","email",gold],["Chat","chat","#7c5cff"],["Gravação","gravacao","#2aa9d6"],["Resumo (gravação)","resumo","#e0509a"],["Triagem de e-mail","triagem","#a0522d"]];
  var fLinhas=FONTES.map(function(f){var a=fAgg[f[1]]||{custoBrl:0,itens:0};return {nome:f[0],itens:a.itens||0,brl:a.custoBrl||0,cor:f[2]};});
  var totF=fLinhas.reduce(function(x,y){return x+y.brl},0);
  chart("chartFonte",{type:"doughnut",data:{labels:fLinhas.map(function(x){return x.nome}),datasets:[{data:fLinhas.map(function(x){return +x.brl.toFixed(4)}),backgroundColor:fLinhas.map(function(x){return x.cor}),borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:muted}}}}});
  var tbf=document.getElementById("tbody-fonte");
  if(tbf){
    if(totF<=0.0000001){tbf.innerHTML='<tr><td colspan="4" class="muted">Sem consumo marcado por fonte no período.</td></tr>';}
    else{tbf.innerHTML=fLinhas.map(function(x){var pct=totF>0?Math.round(x.brl/totF*100):0;return "<tr><td>"+x.nome+"</td><td class='right'>"+fmtInt.format(x.itens)+"</td><td class='right'>"+fmtBRL.format(x.brl)+"</td><td class='right'>"+pct+"%</td></tr>"}).join("");}
  }

  // #5 Por ramal/usuario
  var ramais=ramalAgg(noPeriodo(DADOS.porRamal,iv.de,iv.ate));
  var somaRamais=ramais.reduce(function(a,x){return a+x.custoBrl},0);
  var naoAtrib=t.custoBrl-somaRamais;
  var tbr=document.getElementById("tbody-ramal");
  // O "nao atribuido" entra como item da lista para paginar junto, em vez de
  // ficar fora da paginacao e sumir da conta em listas grandes.
  var listaRamal=ramais.slice();
  if(naoAtrib>0.0000001)listaRamal.push({naoAtrib:true,custoBrl:naoAtrib});
  paginar("ramal",tbr,listaRamal,function(x){
    if(x.naoAtrib)return "<tr><td class='muted'>—</td><td class='muted'>não atribuído</td><td class='right muted'>—</td><td class='right muted'>"+fmtBRL.format(x.custoBrl)+"</td></tr>";
    return "<tr><td>"+(x.ramal||"—")+"</td><td>"+(x.usuario||"—")+"</td><td class='right'>"+fmtInt.format(x.ligacoes)+"</td><td class='right'>"+fmtBRL.format(x.custoBrl)+"</td></tr>";
  },'<tr><td colspan="4" class="muted">Sem consumo atribuído a ramal no período.</td></tr>');

  // Uso por usuário HOJE (mesma fonte, filtrado ao dia atual em UTC).
  var ramaisHoje=ramalAgg(noPeriodo(DADOS.porRamal,hojeUTC(),hojeUTC()));
  var tbrh=document.getElementById("tbody-ramal-hoje");
  if(tbrh){
    if(!ramaisHoje.length)tbrh.innerHTML='<tr><td colspan="6" class="muted">Sem uso registrado hoje.</td></tr>';
    else tbrh.innerHTML=ramaisHoje.map(function(x){return "<tr><td>"+(x.ramal||"—")+"</td><td>"+(x.usuario||"—")+"</td><td class='right'>"+fmtInt.format(x.calls)+"</td><td class='right'>"+fmtInt.format(x.tokens||0)+"</td><td class='right'>"+fmtInt.format(Math.round((x.audioSec||0)/60))+" min</td><td class='right'>"+fmtBRL.format(x.custoBrl)+"</td></tr>"}).join("");
  }

  // Custo por cliente / por assunto (1 linha por chamado criado, ver custoChamados.ts)
  var ivC=intervaloChamados(iv);
  renderChamados(noPeriodo(DADOS.chamados||[],ivC.de,ivC.ate),ivC);
  renderSemChamado(ivC,muted,grid,gold);

  // #8 Ranking dias mais caros
  // Antes mostrava so os 7 primeiros; agora a lista inteira, paginada.
  var top=dias.slice().sort(function(a,b){return b.custoBrl-a.custoBrl});
  var rk=document.getElementById("ranking");
  paginar("caros",rk,top,function(x){
    return "<li><span class='d'>"+x.dia+"</span><span>"+fmtBRL.format(x.custoBrl)+"</span></li>";
  },'<li class="muted">Sem dados no período.</li>');

  // #7 Tabela custo por dia (ordenavel)
  renderTabelaDia(dias);

  // Detalhe por modelo+op (todo o periodo). DADOS.linhas so traz US$: o R$
  // sai de porDiaModelo, somado dia a dia, cada dia no seu cambio.
  var brlModeloOp={};(DADOS.porDiaModelo||[]).forEach(function(r){var k=r.model+"::"+r.op;brlModeloOp[k]=(brlModeloOp[k]||0)+brl(r)});
  var tb=document.getElementById("tbody");
  var linhas=DADOS.linhas||[];
  if(!linhas.length){tb.innerHTML='<tr><td colspan="7" class="muted">Nenhum uso registrado ainda.</td></tr>';}
  else{tb.innerHTML=linhas.map(function(l){var ehMin=/^deepgram/i.test(l.model);var ent=ehMin?(fmtInt.format(Math.round((l.audioSec||0)/60))+" min"):fmtInt.format(l.inputTokens);var sai=ehMin?"—":fmtInt.format(l.outputTokens);return "<tr><td>"+l.model+"</td><td><span class='badge "+(l.op==="resumo"?"resumo":"")+"'>"+l.op+"</span></td><td class='right'>"+ent+"</td><td class='right'>"+sai+"</td><td class='right'>"+fmtInt.format(l.calls)+"</td><td class='right'>"+fmtUSD(l.custoUsd)+"</td><td class='right'>"+fmtBRL.format(brlModeloOp[l.model+"::"+l.op]||0)+"</td></tr>"}).join("");}

  icones(); // KPIs/tabelas acabaram de reescrever HTML com <i data-lucide>
}

// Agrega os chamados criados por cliente e por assunto. So existe para chamados
// criados DEPOIS deste recurso (forward-only) — antes disso nao havia como
// ligar o custo da IA ao cliente.
function agruparChamados(rows,campoNome,campoId){
  var m={};
  (rows||[]).forEach(function(r){
    var nome=(r[campoNome]||"").trim()||("#"+(r[campoId]||"?"));
    var a=m[nome]||(m[nome]={nome:nome,qtd:0,usd:0,brl:0});
    a.qtd++;a.usd+=r.custoUsd||0;a.brl+=brl(r);
  });
  return Object.keys(m).map(function(k){return m[k];}).sort(function(a,b){return b.brl-a.brl;});
}
// ---- IA sem chamado ----
// Conta por SUBTRACAO: gasto de IA do ramal - gasto que virou chamado.
// Nao precisa de dado novo; os dois lados ja vem no payload do painel.
function ehTeste(ramal){return ((DADOS&&DADOS.ramaisTeste)||[]).indexOf(String(ramal||''))>=0;}
// Tudo aqui em R$, cada linha no cambio do seu dia: e o que a tabela mostra.
function renderSemChamado(iv,muted,grid,gold){
  var gastoRows=noPeriodo(DADOS.porRamal||[],iv.de,iv.ate);
  var chamRows=noPeriodo(DADOS.chamados||[],iv.de,iv.ate);

  // Por ramal: gasto total x gasto que virou chamado.
  var m={};
  function slot(r,u){var k=String(r||'');var a=m[k]||(m[k]={ramal:k,usuario:u||'',gasto:0,conv:0});if(!a.usuario&&u)a.usuario=u;return a;}
  gastoRows.forEach(function(r){slot(r.ramal,r.usuario).gasto+=brl(r);});
  chamRows.forEach(function(r){slot(r.ramal,r.usuario).conv+=brl(r);});
  // Gasto ANTERIOR ao corte entra como convertido: naquele periodo o chamado
  // era criado sem ramal, entao o cruzamento nao tem como casar.
  var corte=(DADOS&&DADOS.semChamadoDesde)||"";
  if(corte){
    gastoRows.forEach(function(r){ if(r.dia<corte) slot(r.ramal,r.usuario).conv+=brl(r); });
  }
  var lista=Object.keys(m).map(function(k){var a=m[k];
    a.teste=ehTeste(a.ramal);
    // Clamp: o convertido pode passar o gasto do ramal quando o chamado foi
    // criado por outra pessoa (transferencia). Negativo confundiria mais que
    // ajudaria, entao o piso e zero.
    a.sem=Math.max(0,a.gasto-a.conv);
    a.pct=a.gasto>0?Math.round(a.sem/a.gasto*100):0;
    return a;}).sort(function(a,b){return b.sem-a.sem});

  // Chamados criados por versoes antigas do app vem SEM ramal. Eles existem e
  // custaram, mas nao pertencem a nenhuma linha da tabela. So valem os de
  // DEPOIS do corte: antes dele o gasto ja entrou inteiro como convertido
  // acima, entao somar de novo aqui contava o mesmo chamado duas vezes.
  var convSemRamal=chamRows.filter(function(r){
    return !String(r.ramal||'') && (!corte || r.dia>=corte);
  }).reduce(function(a,r){return a+brl(r)},0);
  var reais=lista.filter(function(x){return !x.teste});
  var gastoReal=reais.reduce(function(a,x){return a+x.gasto},0);
  // Soma o SEM ja limitado por ramal, em vez de subtrair os totais: quando um
  // ramal converte mais do que gastou (chamado aberto por outra pessoa), o
  // excedente apagava o sem chamado dos outros e o cartao dava R$ 0,00
  // enquanto a tabela logo abaixo mostrava linhas com valor.
  var semReal=Math.max(0,reais.reduce(function(a,x){return a+x.sem},0)-convSemRamal);
  var gastoTeste=lista.filter(function(x){return x.teste}).reduce(function(a,x){return a+x.gasto},0);
  var pct=gastoReal>0?Math.round(semReal/gastoReal*100):0;
  document.getElementById('sc-pct').textContent=pct+'%';
  document.getElementById('sc-val').textContent=fmtBRL.format(semReal);
  document.getElementById('sc-teste').textContent=fmtBRL.format(gastoTeste);

  // Tendencia: por dia, quanto virou chamado x quanto nao virou (sem testes).
  var porDia={};
  gastoRows.forEach(function(r){if(ehTeste(r.ramal))return;var d=porDia[r.dia]||(porDia[r.dia]={g:0,cv:0});d.g+=brl(r);if(corte&&r.dia<corte)d.cv+=brl(r);});
  // Sem ramal tambem conta aqui: o chamado existiu, so nao sabemos de quem foi.
  chamRows.forEach(function(r){if(String(r.ramal||'')&&ehTeste(r.ramal))return;var d=porDia[r.dia]||(porDia[r.dia]={g:0,cv:0});d.cv+=brl(r);});
  var dias=Object.keys(porDia).sort();
  chart('chartSemChamado',{type:'line',data:{labels:dias,datasets:[
    {label:'Virou chamado',data:dias.map(function(d){return +Math.min(porDia[d].cv,porDia[d].g).toFixed(4)}),borderColor:'#2f9e6b',backgroundColor:'#2f9e6b',tension:.3,pointRadius:2},
    {label:'Sem chamado',data:dias.map(function(d){return +Math.max(0,porDia[d].g-porDia[d].cv).toFixed(4)}),borderColor:gold,backgroundColor:gold,tension:.3,pointRadius:2}
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:muted}}},scales:{x:{ticks:{color:muted},grid:{display:false}},y:{ticks:{color:muted},grid:{color:grid}}}}});

  var tb=document.getElementById('tbody-semchamado');
  paginar('semchamado',tb,lista,function(x){
    var rot=x.teste?" <span class='muted'>(teste)</span>":'';
    return "<tr><td>"+(x.ramal||'—')+rot+"</td><td>"+(x.usuario||'—')+"</td><td class='right'>"+fmtBRL.format(x.gasto)+"</td><td class='right'>"+fmtBRL.format(x.conv)+"</td><td class='right'>"+fmtBRL.format(x.sem)+"</td><td class='right'>"+(x.teste?'—':x.pct+'%')+"</td></tr>";
  },'<tr><td colspan="6" class="muted">Sem dados no período.</td></tr>');
}

function renderChamados(rows,ivC){
  var av=document.getElementById('ch-aviso');
  if(av)av.innerHTML=(ivC&&ivC.cortado)
    ? 'Mostrando de <b>'+ivC.de+'</b> em diante: o histórico de chamados guarda os últimos '+fmtInt.format(10000)+'. O gasto acima cobre o período inteiro.'
    : '';
  var tbc=document.getElementById("tbody-cliente"),tba=document.getElementById("tbody-assunto");
  // Antes cortava em 25 sem avisar; agora pagina a lista inteira.
  function pintar(chave,tb,lista,rotuloVazio){
    paginar(chave,tb,lista,function(x){
      return "<tr><td>"+escFb(x.nome)+"</td><td class='right'>"+fmtInt.format(x.qtd)+"</td><td class='right'>"
        +fmtBRL.format(x.brl)+"</td><td class='right'>"+fmtBRL4.format(x.qtd?x.brl/x.qtd:0)+"</td></tr>";
    },'<tr><td colspan="4" class="muted">'+rotuloVazio+'</td></tr>');
  }
  var vazio="Nenhum chamado criado no período (só conta a partir de agora).";
  pintar("cliente",tbc,agruparChamados(rows,"cliente","clienteId"),vazio);
  pintar("assunto",tba,agruparChamados(rows,"assunto","assuntoId"),vazio);
}

function baseOpt(muted,grid,money){return {responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:muted},grid:{display:false}},y:{ticks:{color:muted},grid:{color:grid}}}}}

function renderTabelaDia(dias){
  var arr=dias.slice();
  arr.sort(function(a,b){
    var col=ORD.col,va,vb;
    if(col==="tokens"){va=a.inputTokens+a.outputTokens;vb=b.inputTokens+b.outputTokens;}
    else if(col==="dia"){va=a.dia;vb=b.dia;}
    else{va=a[col];vb=b[col];}
    if(va<vb)return -1*ORD.dir;if(va>vb)return 1*ORD.dir;return 0;
  });
  var tb=document.getElementById("tbody-dia");
  paginar("dia",tb,arr,function(x){
    return "<tr><td>"+x.dia+"</td><td class='right'>"+fmtInt.format(x.inputTokens+x.outputTokens)+"</td><td class='right'>"+fmtInt.format(x.calls)+"</td><td class='right'>"+fmtInt.format(x.ligacoes)+"</td><td class='right'>"+fmtInt.format(Math.round((x.audioSec||0)/60))+" min</td><td class='right'>"+fmtBRL.format(x.custoBrl)+"</td></tr>";
  },'<tr><td colspan="6" class="muted">Sem dados no período.</td></tr>');
}

var charts={};
function chart(id,cfg){if(charts[id])charts[id].destroy();charts[id]=new Chart(document.getElementById(id),cfg)}

// ---- Relatorios de custo (multi-secao): CSV (Excel pt-BR) e Excel XML (abas) ----
function baixar(nome,texto,tipo){var b=new Blob([texto],{type:tipo||"text/csv;charset=utf-8"});var u=URL.createObjectURL(b);var a=document.createElement("a");a.href=u;a.download=nome;a.click();setTimeout(function(){URL.revokeObjectURL(u)},1500);}
function numBR(n,dec){return Number(n||0).toFixed(dec).replace(".",",");}
function escXml(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function Sc(s){return {s:s==null?"":String(s)};}          // celula texto
function Nc(n,d){return {n:Number(n||0),d:d};}            // celula numero (d casas)
// Modelo comum das secoes; CSV e Excel consomem daqui (sem duplicar logica).
function montarSecoes(de,ate,incluir3dias,incluirMes){
  var rowsP=noPeriodo(DADOS.porDiaModelo,de,ate);
  var t=totais(rowsP);
  t.ligacoes=ligacoesNoPeriodo(de,ate);
  var dias=porDiaAgg(rowsP);
  var ramais=ramalAgg(noPeriodo(DADOS.porRamal,de,ate));
  var fonteRows=noPeriodo(DADOS.porFonte,de,ate);
  var custoLigBrl=t.transcBrl+t.resumoBrl;
  var secoes=[];

  secoes.push({nome:"Resumo geral",linhas:[
    [Sc("Metrica"),Sc("Valor")],
    [Sc("Custo total (BRL)"),Nc(t.custoBrl,2)],
    [Sc("Custo total (USD)"),Nc(t.custoUsd,4)],
    [Sc("Tokens entrada"),Nc(t.inputTokens,0)],
    [Sc("Tokens saida"),Nc(t.outputTokens,0)],
    [Sc("Tokens total"),Nc(t.inputTokens+t.outputTokens,0)],
    [Sc("Chamadas IA"),Nc(t.calls,0)],
    [Sc("Ligacoes/itens (resumos)"),Nc(t.ligacoes,0)],
    [Sc("Custo transcricao (BRL)"),Nc(t.transcBrl,2)],
    [Sc("Custo resumo (BRL)"),Nc(t.resumoBrl,2)],
    [Sc("Custo medio por ligacao (BRL)"),Nc(t.ligacoes?custoLigBrl/t.ligacoes:0,4)]
  ]});

  if(incluir3dias){
    var l3=[[Sc("dia"),Sc("tokens"),Sc("chamadas"),Sc("ligacoes"),Sc("custo_brl")]];
    var d0=hojeUTC();var alvo=[d0,addDias(d0,-1),addDias(d0,-2)];
    var mapaDia={};dias.forEach(function(x){mapaDia[x.dia]=x;});
    var tot3=0;
    alvo.forEach(function(d){var x=mapaDia[d]||{inputTokens:0,outputTokens:0,calls:0,ligacoes:0,custoUsd:0,custoBrl:0};tot3+=x.custoBrl;l3.push([Sc(d),Nc(x.inputTokens+x.outputTokens,0),Nc(x.calls,0),Nc(x.ligacoes,0),Nc(x.custoBrl,2)]);});
    l3.push([Sc("Total 3 dias"),Sc(""),Sc(""),Sc(""),Nc(tot3,2)]);
    secoes.push({nome:"Ultimos 3 dias",linhas:l3});
  }

  // Coluna "cambio": sem ela o R$ de cada dia nao tem como ser conferido.
  var ld=[[Sc("dia"),Sc("tokens_entrada"),Sc("tokens_saida"),Sc("chamadas"),Sc("ligacoes"),Sc("custo_usd"),Sc("cambio"),Sc("custo_brl")]];
  dias.forEach(function(x){ld.push([Sc(x.dia),Nc(x.inputTokens,0),Nc(x.outputTokens,0),Nc(x.calls,0),Nc(x.ligacoes,0),Nc(x.custoUsd,6),Nc(cotDia(x.dia),4),Nc(x.custoBrl,4)]);});
  secoes.push({nome:"Por dia",linhas:ld});

  var lr=[[Sc("ramal"),Sc("usuario"),Sc("ligacoes"),Sc("chamadas"),Sc("custo_usd"),Sc("custo_brl"),Sc("pct_do_total")]];
  var somaR=ramais.reduce(function(a,x){return a+x.custoUsd},0);
  var somaRBrl=ramais.reduce(function(a,x){return a+x.custoBrl},0);
  ramais.forEach(function(x){var p=t.custoUsd>0?Math.round(x.custoUsd/t.custoUsd*100):0;lr.push([Sc(x.ramal||"—"),Sc(x.usuario||"—"),Nc(x.ligacoes,0),Nc(x.calls,0),Nc(x.custoUsd,6),Nc(x.custoBrl,4),Sc(p+"%")]);});
  var naoAtrib=t.custoUsd-somaR;
  if(naoAtrib>0.0000001){var p2=t.custoUsd>0?Math.round(naoAtrib/t.custoUsd*100):0;lr.push([Sc("—"),Sc("nao atribuido"),Sc(""),Sc(""),Nc(naoAtrib,6),Nc(t.custoBrl-somaRBrl,4),Sc(p2+"%")]);}
  secoes.push({nome:"Por ramal",linhas:lr});

  var lf=[[Sc("fonte"),Sc("itens"),Sc("custo_usd"),Sc("custo_brl"),Sc("pct")]];
  var fAgg={};fonteRows.forEach(function(r){var a=fAgg[r.fonte]||(fAgg[r.fonte]={usd:0,brl:0,itens:0});a.usd+=r.custoUsd;a.brl+=brl(r);if(r.op==="resumo")a.itens+=r.calls;});
  var fLista=[["Ligacoes","ligacao"],["E-mails","email"],["Chat","chat"],["Gravacao","gravacao"],["Resumo (gravacao)","resumo"],["Triagem de e-mail","triagem"]];
  var totF=0;fLista.forEach(function(f){totF+=(fAgg[f[1]]&&fAgg[f[1]].usd)||0;});
  fLista.forEach(function(f){var a=fAgg[f[1]]||{usd:0,brl:0,itens:0};var p=totF>0?Math.round(a.usd/totF*100):0;lf.push([Sc(f[0]),Nc(a.itens,0),Nc(a.usd,6),Nc(a.brl,4),Sc(p+"%")]);});
  secoes.push({nome:"Por fonte",linhas:lf});

  // Custo por cliente / assunto: so tem linha para chamados criados apos o
  // recurso existir, entao a secao so entra quando ha dado no periodo.
  var chamadosP=noPeriodo(DADOS.chamados||[],de,ate);
  if(chamadosP.length){
    [["Por cliente","cliente","clienteId"],["Por assunto","assunto","assuntoId"]].forEach(function(cfg){
      var l=[[Sc(cfg[1]),Sc("chamados"),Sc("custo_usd"),Sc("custo_brl"),Sc("custo_medio_brl")]];
      agruparChamados(chamadosP,cfg[1],cfg[2]).forEach(function(x){
        l.push([Sc(x.nome),Nc(x.qtd,0),Nc(x.usd,6),Nc(x.brl,4),Nc(x.qtd?x.brl/x.qtd:0,4)]);
      });
      secoes.push({nome:cfg[0],linhas:l});
    });
  }

  var lm=[[Sc("modelo"),Sc("operacao"),Sc("tokens_entrada"),Sc("tokens_saida"),Sc("chamadas"),Sc("custo_usd"),Sc("custo_brl")]];
  var moAgg={};rowsP.forEach(function(r){var k=r.model+"||"+r.op;var a=moAgg[k]||(moAgg[k]={model:r.model,op:r.op,i:0,o:0,calls:0,usd:0,brl:0});a.i+=r.inputTokens;a.o+=r.outputTokens;a.calls+=r.calls;a.usd+=r.custoUsd;a.brl+=brl(r);});
  Object.keys(moAgg).forEach(function(k){var a=moAgg[k];lm.push([Sc(a.model),Sc(a.op),Nc(a.i,0),Nc(a.o,0),Nc(a.calls,0),Nc(a.usd,6),Nc(a.brl,4)]);});
  secoes.push({nome:"Por modelo e operacao",linhas:lm});

  var lt=[[Sc("operacao"),Sc("custo_usd"),Sc("custo_brl"),Sc("pct")]];
  var totTR=t.transcUsd+t.resumoUsd;
  lt.push([Sc("Transcricao"),Nc(t.transcUsd,6),Nc(t.transcBrl,4),Sc((totTR>0?Math.round(t.transcUsd/totTR*100):0)+"%")]);
  lt.push([Sc("Resumo"),Nc(t.resumoUsd,6),Nc(t.resumoBrl,4),Sc((totTR>0?Math.round(t.resumoUsd/totTR*100):0)+"%")]);
  secoes.push({nome:"Transcricao x Resumo",linhas:lt});

  if(incluirMes){
    var mesAgg={};rowsP.forEach(function(r){var mes=r.dia.slice(0,7);var a=mesAgg[mes]||(mesAgg[mes]={i:0,o:0,calls:0,ligacoes:0,usd:0,brl:0});a.i+=r.inputTokens;a.o+=r.outputTokens;a.calls+=r.calls;if(r.op==="resumo")a.ligacoes+=r.calls;a.usd+=r.custoUsd;a.brl+=brl(r);});
    var meses=Object.keys(mesAgg).sort();
    var lms=[[Sc("mes"),Sc("tokens"),Sc("chamadas"),Sc("ligacoes"),Sc("custo_brl"),Sc("variacao_vs_anterior")]];
    var prev=null;
    meses.forEach(function(m){var a=mesAgg[m];var vb=a.brl;var vv="—";if(prev!==null&&prev>0){var dd=(vb-prev)/prev*100;vv=(dd>=0?"+":"")+Math.round(dd)+"%";}lms.push([Sc(m),Nc(a.i+a.o,0),Nc(a.calls,0),Nc(a.ligacoes,0),Nc(vb,2),Sc(vv)]);prev=vb;});
    secoes.push({nome:"Por mes",linhas:lms});
  }

  return secoes;
}
// Cabecalho dos relatorios: com o campo vazio cada dia tem o seu (coluna
// "cambio" em Por dia); preenchido, e o valor fixo da simulacao.
function rotuloCambio(){return CAMBIO!=null?numBR(CAMBIO,4)+" (fixo, simulacao)":"fechamento de cada dia (ver Por dia)"}
function celCsv(x){return x.n!==undefined?numBR(x.n,x.d):x.s;}
function secoesParaCsv(secoes,de,ate,titulo){
  var L=[];var add=function(){L.push(Array.prototype.slice.call(arguments).map(csvCampo).join(";"));};
  var ger="";try{ger=new Date().toLocaleString("pt-BR");}catch(e){ger="";}
  add("RELATORIO DE CUSTOS DE IA - "+titulo);
  add("Gerado em",ger);add("Periodo",de+" a "+ate);add("Cambio (USD->BRL)",rotuloCambio());add("");
  secoes.forEach(function(sec){
    add("== "+sec.nome.toUpperCase()+" ==");
    sec.linhas.forEach(function(row){L.push(row.map(function(x){return csvCampo(celCsv(x));}).join(";"));});
    add("");
  });
  return "\\ufeff"+L.join("\\r\\n");
}
function secoesParaXml(secoes,de,ate,titulo){
  var ger="";try{ger=new Date().toLocaleString("pt-BR");}catch(e){ger="";}
  var info={nome:"Info",linhas:[
    [Sc("Relatorio"),Sc(titulo)],
    [Sc("Gerado em"),Sc(ger)],
    [Sc("Periodo"),Sc(de+" a "+ate)],
    [Sc("Cambio (USD->BRL)"),Sc(rotuloCambio())]
  ]};
  var todas=[info].concat(secoes);
  var x=['<?xml version="1.0" encoding="UTF-8"?>','<?mso-application progid="Excel.Sheet"?>','<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'];
  todas.forEach(function(sec){
    x.push('<Worksheet ss:Name="'+escXml(sec.nome).slice(0,31)+'"><Table>');
    sec.linhas.forEach(function(row){
      x.push('<Row>'+row.map(function(c){
        if(c.n!==undefined)return '<Cell><Data ss:Type="Number">'+Number(c.n).toFixed(c.d)+'</Data></Cell>';
        return '<Cell><Data ss:Type="String">'+escXml(c.s)+'</Data></Cell>';
      }).join("")+'</Row>');
    });
    x.push('</Table></Worksheet>');
  });
  x.push('</Workbook>');
  return x.join("\\n");
}
function csvCompleto(){if(!DADOS){alert("Sem dados.");return;}var de=minDia(),ate=hojeUTC();baixar("relatorio_custos_completo_"+ate+".csv",secoesParaCsv(montarSecoes(de,ate,true,true),de,ate,"COMPLETO (todo o historico)"));}
function csvPeriodo(){if(!DADOS){alert("Sem dados.");return;}var iv=intervalo();baixar("relatorio_custos_"+iv.de+"_a_"+iv.ate+".csv",secoesParaCsv(montarSecoes(iv.de,iv.ate,false,false),iv.de,iv.ate,"PERIODO "+iv.de+" a "+iv.ate));}
function xlsCompleto(){if(!DADOS){alert("Sem dados.");return;}var de=minDia(),ate=hojeUTC();baixar("relatorio_custos_completo_"+ate+".xls",secoesParaXml(montarSecoes(de,ate,true,true),de,ate,"COMPLETO (todo o historico)"),"application/vnd.ms-excel;charset=utf-8");}
function xlsPeriodo(){if(!DADOS){alert("Sem dados.");return;}var iv=intervalo();baixar("relatorio_custos_"+iv.de+"_a_"+iv.ate+".xls",secoesParaXml(montarSecoes(iv.de,iv.ate,false,false),iv.de,iv.ate,"PERIODO "+iv.de+" a "+iv.ate),"application/vnd.ms-excel;charset=utf-8");}

// ---- controles ----
function selPeriodo(p){PERIODO.preset=p;
  var segs=document.querySelectorAll("#seg-periodo button");for(var i=0;i<segs.length;i++)segs[i].classList.toggle("on",segs[i].getAttribute("data-p")===p);
  document.getElementById("custom-range").classList.toggle("hidden",p!=="custom");
  render();}
(function(){var segs=document.querySelectorAll("#seg-periodo button");for(var i=0;i<segs.length;i++)segs[i].onclick=function(){selPeriodo(this.getAttribute("data-p"))};})();
document.getElementById("dt-de").onchange=function(){PERIODO.de=this.value||null;render()};
document.getElementById("dt-ate").onchange=function(){PERIODO.ate=this.value||null;render()};
document.getElementById("cambio").oninput=function(){var v=parseFloat(this.value);CAMBIO=isFinite(v)&&v>0?v:null;render()};
document.getElementById("csv-completo").onclick=csvCompleto;
document.getElementById("csv-periodo").onclick=csvPeriodo;
document.getElementById("xls-completo").onclick=xlsCompleto;
document.getElementById("xls-periodo").onclick=xlsPeriodo;
document.getElementById("painel-nov").onclick=abrirNovidadesPainel;
document.getElementById("nov-x").onclick=fecharNovidadesPainel;
document.getElementById("nov-ok").onclick=fecharNovidadesPainel;
document.getElementById("nov-overlay").addEventListener("click",function(e){if(e.target===this)fecharNovidadesPainel();});
// Auto-refresh do painel: SEMPRE ligado, a cada 1 min (obrigatorio; sem opcao de desligar).
setInterval(function(){if(senha()&&!document.getElementById("app").classList.contains("hidden"))carregar();},60000);
(function(){var ths=document.querySelectorAll("#tbody-dia");
  var heads=document.querySelectorAll("th.sortable");for(var i=0;i<heads.length;i++)heads[i].onclick=function(){var col=this.getAttribute("data-col");if(ORD.col===col)ORD.dir*=-1;else{ORD.col=col;ORD.dir=col==="dia"?-1:-1;}resetPag("dia");if(DADOS)render();};})();

function mostrarLogin(err){document.getElementById("app").classList.add("hidden");document.getElementById("login").classList.remove("hidden");document.getElementById("login-err").textContent=err||"";}
function entrar(){var v=document.getElementById("senha").value||"";try{sessionStorage.setItem("admin-pwd",v)}catch(e){}carregar();}
document.getElementById("entrar").onclick=entrar;
document.getElementById("senha").addEventListener("keydown",function(e){if(e.key==="Enter")entrar()});
document.getElementById("refresh").onclick=carregar;

// Barra de titulo customizada (so dentro do app Electron).
(function(){
  if(!window.winCtl)return;
  document.body.classList.add("electron");
  var min=document.getElementById("tb-min"),max=document.getElementById("tb-max"),cls=document.getElementById("tb-close");
  if(min)min.onclick=function(){window.winCtl.minimizar()};
  if(max)max.onclick=function(){window.winCtl.maximizar()};
  if(cls)cls.onclick=function(){window.winCtl.fechar()};
  function setMax(m){document.body.classList.toggle("win-max",!!m)}
  if(window.winCtl.estaMaximizada)window.winCtl.estaMaximizada().then(setMax);
  if(window.winCtl.onEstado)window.winCtl.onEstado(setMax);
})();

// ---- Aba Online: quem esta com o app aberto, por setor, e em qual versao ----
// Os dados vem de /api/admin/online (Ably + versao anotada no Redis). Atualiza
// a cada 1 min so com a aba aberta e a janela visivel: cada leitura custa 3
// comandos do Redis.
var ONLINE=null,onlineTimer=null;
var ONLINE_MS=60000;
var PESO_STATUS={online:0,saiu:1,offline:2};
function onlineVisivel(){var v=document.getElementById("view-online");return !!v&&!v.classList.contains("hidden")&&!document.hidden;}
async function carregarOnline(){
  clearTimeout(onlineTimer);
  var st=document.getElementById("on-atualizado");
  try{
    var r=await fetch("/api/admin/online",{headers:{Authorization:"Bearer "+senha()}});
    if(!r.ok){ if(st)st.textContent="Falha ao carregar (HTTP "+r.status+")"; }
    else{ var d=await r.json(); ONLINE=d&&d.data; renderOnline(); }
  }catch(e){ if(st)st.textContent="Falha de rede ao carregar"; console.warn("[online]",e); }
  onlineTimer=setTimeout(function(){if(onlineVisivel())carregarOnline();else onlineTimer=null;},ONLINE_MS);
}
document.addEventListener("visibilitychange",function(){if(onlineVisivel()&&!onlineTimer)carregarOnline();});
(function(){var b=document.getElementById("on-refresh");if(b)b.onclick=carregarOnline;})();
function escAttr(s){return escFb(s).replace(/"/g,"&quot;");}
function horaBR(ms){try{return new Date(ms).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});}catch(e){return "";}}
// "às 13:10" (hoje), "ontem às 17:52", "10/11 às 18:03"
function quandoBR(ms){
  if(!ms)return "";
  var d=new Date(ms),h=new Date(),ontem=new Date(h.getFullYear(),h.getMonth(),h.getDate()-1);
  if(d.toDateString()===h.toDateString())return "às "+horaBR(ms);
  if(d.toDateString()===ontem.toDateString())return "ontem às "+horaBR(ms);
  return d.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})+" às "+horaBR(ms);
}
function iniciais(nome){var p=String(nome||"").split(" ").filter(Boolean);return ((p[0]||"?").charAt(0)+(p[1]?p[1].charAt(0):"")).toUpperCase();}
function cmpVer(a,b){var x=String(a).split("."),y=String(b).split(".");for(var i=0;i<Math.max(x.length,y.length);i++){var d=(Number(x[i])||0)-(Number(y[i])||0);if(d)return d;}return 0;}
function tipoVer(v,nova){return !v?"nd":(!nova||cmpVer(v,nova)>=0)?"ok":"old";}
function ordemPessoas(a,b){return (PESO_STATUS[a.status]-PESO_STATUS[b.status])||String(a.ramal||"~").localeCompare(String(b.ramal||"~"),"pt-BR",{numeric:true});}
function renderOnline(){
  var d=ONLINE;if(!d)return;
  var nova=d.versaoMaisNova||"";
  var ps=(d.pessoas||[]).slice().sort(ordemPessoas);
  var on=ps.filter(function(p){return p.status==="online";});
  var saiu=ps.filter(function(p){return p.status==="saiu";}).length;
  var off=ps.filter(function(p){return p.status==="offline";}).length;
  var nb=document.getElementById("nav-online-n");if(nb){nb.textContent=on.length;nb.classList.remove("hidden");}
  var st=document.getElementById("on-atualizado");if(st)st.textContent="Atualizado às "+horaBR(d.geradoEm)+" · a cada 1 min";
  var av=document.getElementById("on-avisos");if(av)av.innerHTML=(d.avisos||[]).map(function(a){return '<div class="on-erro">'+escFb(a)+'</div>';}).join("");

  // Anel: quem esta online entre todos que ja apareceram
  var total=ps.length,circ=2*Math.PI*50,arco=total?circ*on.length/total:0;
  var maq=on.filter(function(p){return p.maquinas>1;}).length;
  var res=document.getElementById("on-resumo");
  if(res)res.innerHTML='<svg class="on-anel" role="img" aria-label="'+on.length+' de '+total+' online" width="104" height="104" viewBox="0 0 120 120">'
    +'<circle class="trilho" cx="60" cy="60" r="50" fill="none" stroke-width="12"></circle>'
    +(arco?'<circle class="arco" cx="60" cy="60" r="50" fill="none" stroke-width="12" stroke-linecap="round" stroke-dasharray="'+arco.toFixed(1)+' '+circ.toFixed(1)+'" transform="rotate(-90 60 60)"></circle>':'')
    +'<text class="n" x="60" y="62" text-anchor="middle">'+on.length+'</text><text class="de" x="60" y="82" text-anchor="middle">de '+total+'</text></svg>'
    +'<div><div class="on-big">'+(on.length===1?"1 pessoa online agora":on.length+" pessoas online agora")+'</div>'
    +'<div class="on-sub">'+saiu+' saíram hoje · '+off+' offline'
    +(maq?'<br>'+maq+(maq===1?' ramal aberto':' ramais abertos')+' em mais de uma máquina':'')+'</div></div>';

  // Barras por versao (so de quem esta online)
  var g={};on.forEach(function(p){var k=p.versao||"";g[k]=(g[k]||0)+1;});
  var ks=Object.keys(g).sort(function(a,b){if(!a)return 1;if(!b)return -1;return cmpVer(b,a);});
  var vt=document.getElementById("on-vers-tit");if(vt)vt.textContent="Versões de quem está online"+(nova?" · mais nova "+nova:"");
  var vs=document.getElementById("on-vers");
  if(vs)vs.innerHTML=ks.length?ks.map(function(k){
    var t=tipoVer(k,nova),w=(g[k]/on.length*100).toFixed(1);
    return '<div class="on-ver"><b class="on-'+t+'">'+escFb(k||"sem versão")+'</b><div class="bar"><i class="bg-'+t+'" style="width:'+w+'%"></i></div><span class="right">'+g[k]+'</span></div>';
  }).join(""):'<div class="muted">Ninguém online agora.</div>';

  // Quem precisa atualizar (online ou nao)
  var desat=ps.filter(function(p){return tipoVer(p.versao,nova)==="old";});
  var al=document.getElementById("on-alerta");
  if(al)al.innerHTML=desat.length
    ?'<div class="on-alerta"><div class="tit"><i data-lucide="triangle-alert"></i> '+(desat.length===1?"1 pessoa precisa atualizar":desat.length+" pessoas precisam atualizar")+'</div><div class="on-chips">'
      +desat.map(function(p){return '<span class="on-chip"><span class="on-dot '+p.status+'"></span><b>'+escFb(p.nome)+'</b><span class="muted">'+escFb((p.ramal||"sem ramal")+" · "+p.versao)+'</span></span>';}).join("")+'</div></div>'
    :(nova&&ps.some(function(p){return p.versao;})?'<div class="on-alerta tudo-ok"><div class="tit"><i data-lucide="circle-check"></i> Todo mundo com versão conhecida está na '+escFb(nova)+'</div></div>':'');

  // Cartoes por setor (sem setor por ultimo)
  var por={};ps.forEach(function(p){var s=p.setor||"";(por[s]=por[s]||[]).push(p);});
  var setores=Object.keys(por).sort(function(a,b){if(!a)return 1;if(!b)return -1;return a.localeCompare(b,"pt-BR");});
  var sc=document.getElementById("on-setores");
  if(sc)sc.innerHTML=setores.length?setores.map(function(s){
    var lista=por[s],n=lista.filter(function(p){return p.status==="online";}).length;
    return '<section class="on-sec"><div class="on-sec-h"><h2>'+escFb(s||"Sem setor informado")+'</h2><span class="n">'+n+' de '+lista.length+' online</span>'
      +'<div class="bar"><i style="width:'+Math.round(n/lista.length*100)+'%"></i></div></div>'
      +'<div class="on-grid">'+lista.map(function(p){return cartaoOnline(p,nova);}).join("")+'</div></section>';
  }).join(""):'<div class="panel muted">Ninguém apareceu ainda.</div>';
  icones();
}
function cartaoOnline(p,nova){
  var t=tipoVer(p.versao,nova);
  var rot={online:"online",saiu:"saiu hoje",offline:"offline"}[p.status]||"";
  var tempo=p.status==="online"?(p.abriuEm?"Abriu às "+horaBR(p.abriuEm):"Online agora")
    :p.status==="saiu"?("Visto "+quandoBR(p.vistoEm||p.abriuEm)+(p.abriuEm?" · abriu às "+horaBR(p.abriuEm):""))
    :(p.vistoEm?"Visto "+quandoBR(p.vistoEm):"Ainda sem versão anotada");
  var contas=p.contas||[];
  var conta=contas.length?contas[0]+(contas.length>1?" +"+(contas.length-1):""):"sem conta Google conhecida";
  return '<div class="on-card'+(p.status==="online"?"":" fora")+'"><div class="cab">'
    +'<div class="on-av">'+escFb(iniciais(p.nome))+'<span class="on-dot '+p.status+'"></span></div>'
    +'<div style="min-width:0"><div class="on-nome" title="'+escAttr(p.nome)+'">'+escFb(p.nome)+'</div>'
    +'<div class="on-linha">'+(p.ramal?"Ramal "+escFb(p.ramal)+" · ":"")+rot+'</div></div></div>'
    +'<div class="on-tags"><span class="on-tag '+t+'">'+escFb(p.versao||"sem versão")+'</span>'
    +(p.maquinas>1?'<span class="on-tag maq">'+p.maquinas+' máquinas</span>':'')
    // PC da ultima conexao (app 1.9.5+). Com o ramal em duas maquinas, e o da
    // que conectou por ultimo; o title avisa para ninguem ler como lista.
    +(p.pc?'<span class="on-tag pc" title="'+escAttr("PC da última conexão"+(p.maquinas>1?" (o ramal está aberto em "+p.maquinas+" máquinas)":""))+'">'+escFb(p.pc)+'</span>':'')+'</div>'
    +'<div class="on-linha ell" title="'+escAttr(contas.join(", "))+'">'+escFb(conta)+'</div>'
    +'<div class="on-linha">'+escFb(tempo)+'</div></div>';
}

icones(); // primeira passada: icones estaticos (topbar, abas, cards, botoes)
if(senha())carregar();
</script>
</body>
</html>`;
