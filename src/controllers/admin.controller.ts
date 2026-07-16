import { Request, Response } from "express";
import { custoUsd, getUsdBrl } from "../services/pricing";
import { getRelatorioUso } from "../services/usage";
import {
  registrarFeedback,
  listarFeedback,
  type FeedbackEntry,
} from "../services/feedback";

function senhaAdmin(): string {
  return process.env.ADMIN_PASSWORD || "Contas@2074";
}

function isAdmin(req: Request): boolean {
  const auth = req.header("authorization") || "";
  return auth === `Bearer ${senhaAdmin()}`;
}

// POST /api/feedback — registra feedback do resumo da IA (explicito/implicito).
// Aceita SO campos conhecidos e limitados (nunca transcricao/conteudo do resumo).
export async function feedbackController(req: Request, res: Response) {
  const b = (
    req.body && typeof req.body === "object" ? req.body : {}
  ) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const bool = (v: unknown) => v === true || v === "true";
  const ratingRaw = str(b.rating);
  const dv = (
    b.divergencias && typeof b.divergencias === "object" ? b.divergencias : {}
  ) as Record<string, unknown>;

  const entry: FeedbackEntry = {
    ts: new Date().toISOString(),
    tipo: b.tipo === "implicito" ? "implicito" : "explicito",
    origem: str(b.origem).slice(0, 20) || "ligacao",
    id: str(b.id).slice(0, 120),
    modelo: str(b.modelo).slice(0, 60) || undefined,
    ramal: str(b.ramal).slice(0, 40) || undefined,
    usuario: str(b.usuario).slice(0, 120) || undefined,
    rating: ratingRaw === "up" || ratingRaw === "down" ? ratingRaw : null,
    tags: Array.isArray(b.tags)
      ? b.tags.map((t) => String(t).slice(0, 60)).slice(0, 10)
      : [],
    comentario: str(b.comentario).slice(0, 1000) || undefined,
    divergencias: {
      clienteMudou: bool(dv.clienteMudou),
      setorMudou: bool(dv.setorMudou),
      executorMudou: bool(dv.executorMudou),
      assuntoSugerido: str(dv.assuntoSugerido).slice(0, 120),
      assuntoFinal: str(dv.assuntoFinal).slice(0, 120),
      assuntoMudou: bool(dv.assuntoMudou),
    },
    descEditada: bool(b.descEditada),
    iaOk: b.iaOk === undefined ? undefined : bool(b.iaOk),
  };
  await registrarFeedback(entry).catch(() => undefined);
  res.status(200).json({ ok: true });
}

// GET /api/admin/feedback — lista os feedbacks (protegido pela senha do admin).
export async function adminFeedbackController(req: Request, res: Response) {
  if (!isAdmin(req)) {
    res.status(401).json({ ok: false, message: "Nao autorizado." });
    return;
  }
  const itens = await listarFeedback(500).catch(() => []);
  res.status(200).json({ ok: true, itens });
}

// GET /api/admin/uso — relatorio de tokens + custo (protegido por senha).
export async function adminUsoController(req: Request, res: Response) {
  if (!isAdmin(req)) {
    res.status(401).json({ ok: false, message: "Nao autorizado." });
    return;
  }

  const [relatorio, cotacao] = await Promise.all([
    getRelatorioUso(),
    getUsdBrl(),
  ]);

  // Agregado por modelo+operacao (todo o periodo), com custo.
  const linhas = relatorio.linhas
    .map((l) => ({
      ...l,
      custoUsd: custoUsd(l.model, l.inputTokens, l.outputTokens),
    }))
    .sort((a, b) => b.custoUsd - a.custoUsd);

  // Detalhe por dia+modelo+op, ja com custo por linha (precificado por modelo).
  // O frontend agrega/filtra por periodo em cima disto.
  const porDiaModelo = relatorio.porDiaModelo.map((d) => ({
    ...d,
    custoUsd: custoUsd(d.model, d.inputTokens, d.outputTokens),
  }));

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
        custoUsd: 0,
      };
    cur.inputTokens += it.inputTokens;
    cur.outputTokens += it.outputTokens;
    cur.calls += it.calls;
    cur.custoUsd += custoUsd(it.model, it.inputTokens, it.outputTokens);
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
        custoUsd: 0,
      };
    cur.inputTokens += it.inputTokens;
    cur.outputTokens += it.outputTokens;
    cur.calls += it.calls;
    cur.custoUsd += custoUsd(it.model, it.inputTokens, it.outputTokens);
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
      acc.custoUsd += l.custoUsd;
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, calls: 0, custoUsd: 0 },
  );
  const custoBrl = totais.custoUsd * cotacao;

  res.status(200).json({
    ok: true,
    configurado: relatorio.configurado,
    cotacao,
    totais: {
      ...totais,
      tokens: totais.inputTokens + totais.outputTokens,
      custoBrl,
    },
    linhas,
    porDiaModelo,
    porRamal,
    porFonte,
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
.brand{display:flex;align-items:center;gap:12px}
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
.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:22px}
@media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}}
.card{background:linear-gradient(180deg,var(--card-2),var(--card));border:1px solid var(--border);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--border)}
.card.brand::before{background:var(--brand-2)}.card.accent::before{background:var(--accent)}.card.gold::before{background:var(--gold)}
.card .k{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.card .v{font-size:23px;font-weight:700;margin-top:8px}
.card .s{font-size:12px;color:var(--muted);margin-top:4px}
.card.accent .v{color:var(--accent)}.card.gold .v{color:var(--gold)}
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
.right{text-align:right}
.note{font-size:12.5px;color:var(--muted);background:var(--accent-soft);border:1px solid var(--border);border-radius:9px;padding:9px 12px;margin-bottom:14px}
.rank{list-style:none}
.rank li{display:flex;justify-content:space-between;gap:12px;padding:9px 4px;border-bottom:1px solid var(--border);font-size:13px}
.rank li:last-child{border-bottom:none}
.rank .d{color:var(--muted)}
#login{position:fixed;inset:0;background:rgba(6,12,20,.85);display:flex;align-items:center;justify-content:center;z-index:50}
.login-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:30px;width:360px;max-width:92vw;box-shadow:0 24px 60px rgba(0,0,0,.5);text-align:center}
.login-card h2{margin-bottom:8px}.login-card p{color:var(--muted);font-size:13px;margin-bottom:18px}
.login-card input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:15px;margin-bottom:12px}
.login-card button{width:100%;padding:12px;border-radius:10px;border:none;background:linear-gradient(135deg,var(--brand),var(--brand-2));color:#fff;font-weight:700;font-size:15px;cursor:pointer}
.login-err{color:var(--danger);font-size:13px;margin-top:10px;min-height:18px}
.hidden{display:none!important}
.muted{color:var(--muted)}
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
    <h2>Painel de Custos</h2>
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
    <button class="icon-btn" id="tema" title="Alternar tema">☀️</button>
    <button class="icon-btn" id="refresh" title="Atualizar">↻</button>
  </div>

  <h1>Custos de Inteligência Artificial</h1>
  <div class="sub" id="status">Consumo de tokens do Gemini (transcrição + resumo) e custo estimado.</div>

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
    <label>Câmbio R$</label> <input type="number" step="0.01" min="0" class="cambio" id="cambio" title="Câmbio USD→BRL (editável)" />
    <button class="mini-btn" id="csv-dia" title="Exportar CSV por dia">⬇ CSV dia</button>
    <button class="mini-btn" id="csv-ramal" title="Exportar CSV por ramal">⬇ CSV ramal</button>
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="auto" /> auto 5min</label>
  </div>

  <div class="cards">
    <div class="card accent"><div class="k">Custo total (R$)</div><div class="v" id="c-brl">—</div><div class="s" id="c-brl-s"></div></div>
    <div class="card brand"><div class="k">Custo total (US$)</div><div class="v" id="c-usd">—</div><div class="s">preços de referência</div></div>
    <div class="card gold"><div class="k">Projeção do mês (R$)</div><div class="v" id="c-proj">—</div><div class="s" id="c-proj-s">no ritmo atual</div></div>
    <div class="card"><div class="k">Tokens (período)</div><div class="v" id="c-tok">—</div><div class="s" id="c-tok-s"></div></div>
    <div class="card"><div class="k">Chamadas de IA</div><div class="v" id="c-calls">—</div><div class="s">transcrição + resumo</div></div>
  </div>

  <div class="panel">
    <h3>Por ligação (transcrição + resumo) — no período</h3>
    <div class="cards" style="grid-template-columns:repeat(3,1fr);margin-bottom:0">
      <div class="card brand"><div class="k">Ligações resumidas</div><div class="v" id="l-count">—</div><div class="s">com resumo da IA</div></div>
      <div class="card accent"><div class="k">Custo total das ligações</div><div class="v" id="l-total">—</div><div class="s" id="l-total-s"></div></div>
      <div class="card gold"><div class="k">Custo médio por ligação</div><div class="v" id="l-avg">—</div><div class="s" id="l-avg-s">R$</div></div>
    </div>
  </div>

  <div class="grid2">
    <div class="panel" style="margin:0"><h3>Custo por dia (R$)</h3><div class="chart-box"><canvas id="chartCustoDia"></canvas></div></div>
    <div class="panel" style="margin:0"><h3>Transcrição vs. resumo (R$)</h3><div class="chart-box"><canvas id="chartOp"></canvas></div></div>
  </div>

  <div class="grid2">
    <div class="panel" style="margin:0"><h3>Custo por modelo (R$)</h3><div class="chart-box"><canvas id="chartModelo"></canvas></div></div>
    <div class="panel" style="margin:0"><h3>Tendência do custo médio por ligação (R$)</h3><div class="chart-box"><canvas id="chartTend"></canvas></div></div>
  </div>

  <div class="grid2">
    <div class="panel" style="margin:0"><h3>Custo por fonte (R$)</h3><div class="chart-box"><canvas id="chartFonte"></canvas></div></div>
    <div class="panel" style="margin:0">
      <h3>Por fonte — no período</h3>
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
      <h3>Gasto por ramal / usuário — no período</h3>
      <div style="overflow:auto">
        <table>
          <thead><tr><th>Ramal</th><th>Usuário</th><th class="right">Ligações</th><th class="right">Custo R$</th></tr></thead>
          <tbody id="tbody-ramal"><tr><td colspan="4" class="muted">—</td></tr></tbody>
        </table>
      </div>
    </div>
    <div class="panel" style="margin:0"><h3>Dias mais caros</h3><ul class="rank" id="ranking"><li class="muted">—</li></ul></div>
  </div>

  <div class="panel">
    <h3>Custo por dia</h3>
    <div style="overflow:auto">
      <table>
        <thead><tr>
          <th class="sortable" data-col="dia">Dia</th>
          <th class="sortable right" data-col="tokens">Tokens</th>
          <th class="sortable right" data-col="calls">Chamadas</th>
          <th class="sortable right" data-col="ligacoes">Ligações</th>
          <th class="sortable right" data-col="custoUsd">Custo R$</th>
        </tr></thead>
        <tbody id="tbody-dia"><tr><td colspan="5" class="muted">Carregando…</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h3>Detalhe por modelo e operação (todo o período)</h3>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>Modelo</th><th>Operação</th><th class="right">Tokens entrada</th><th class="right">Tokens saída</th><th class="right">Chamadas</th><th class="right">Custo US$</th><th class="right">Custo R$</th></tr></thead>
        <tbody id="tbody"><tr><td colspan="7" class="muted">Carregando…</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h3>Feedback da IA</h3>
    <div id="fb-stats" class="muted" style="margin-bottom:12px">Carregando…</div>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>Data</th><th>Usuário</th><th>Fonte</th><th>Avaliação</th><th>Divergências / tags</th><th>Comentário</th></tr></thead>
        <tbody id="tbody-feedback"><tr><td colspan="6" class="muted">Carregando…</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<script>
var THEME_KEY="painel-tema";
function setTheme(t){document.documentElement.setAttribute("data-theme",t);document.getElementById("tema").textContent=t==="dark"?"☀️":"🌙";try{localStorage.setItem(THEME_KEY,t)}catch(e){}}
setTheme((function(){try{return localStorage.getItem(THEME_KEY)||"dark"}catch(e){return "dark"}})());
document.getElementById("tema").onclick=function(){setTheme(document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark");if(DADOS)render()};

var fmtBRL=new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL",minimumFractionDigits:2,maximumFractionDigits:2});
var fmtBRL4=new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL",minimumFractionDigits:2,maximumFractionDigits:4});
var fmtInt=new Intl.NumberFormat("pt-BR");
function fmtUSD(v){return "US$ "+Number(v||0).toFixed(4)}

function senha(){try{return sessionStorage.getItem("admin-pwd")||""}catch(e){return ""}}
function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}

var DADOS=null;          // ultimo payload da API
var CAMBIO=null;         // override manual do cambio (null = usa o da API)
var PERIODO={preset:"30d",de:null,ate:null};
var ORD={col:"dia",dir:-1};
var timerAuto=null;

function cot(){return CAMBIO!=null?CAMBIO:(DADOS&&DADOS.cotacao)||0}

// ---- datas (UTC, batendo com as chaves YYYY-MM-DD do backend) ----
function hojeUTC(){return new Date().toISOString().slice(0,10)}
function addDias(s,n){var d=new Date(s+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function diffDias(a,b){return Math.round((new Date(b+"T00:00:00Z")-new Date(a+"T00:00:00Z"))/86400000)}
function primeiroDiaMes(){return hojeUTC().slice(0,8)+"01"}
function ultimoDiaMes(){var d=new Date();return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()}
function minDia(){var xs=(DADOS&&DADOS.porDiaModelo||[]).map(function(x){return x.dia});return xs.length?xs.sort()[0]:hojeUTC()}
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
function noPeriodo(rows,de,ate){return (rows||[]).filter(function(r){return r.dia>=de&&r.dia<=ate})}

// ---- agregacoes ----
function totais(rows){var t={inputTokens:0,outputTokens:0,calls:0,custoUsd:0,ligacoes:0,transcUsd:0,resumoUsd:0};
  rows.forEach(function(r){t.inputTokens+=r.inputTokens;t.outputTokens+=r.outputTokens;t.calls+=r.calls;t.custoUsd+=r.custoUsd;
    if(r.op==="resumo"){t.ligacoes+=r.calls;t.resumoUsd+=r.custoUsd}if(r.op==="transcricao")t.transcUsd+=r.custoUsd});
  return t;}
function porDiaAgg(rows){var m={};
  rows.forEach(function(r){var a=m[r.dia]||(m[r.dia]={dia:r.dia,inputTokens:0,outputTokens:0,calls:0,ligacoes:0,custoUsd:0});
    a.inputTokens+=r.inputTokens;a.outputTokens+=r.outputTokens;a.calls+=r.calls;a.custoUsd+=r.custoUsd;if(r.op==="resumo")a.ligacoes+=r.calls});
  return Object.keys(m).sort().map(function(k){return m[k]});}
function ramalAgg(rows){var m={};
  rows.forEach(function(r){var a=m[r.ramal]||(m[r.ramal]={ramal:r.ramal,usuario:r.usuario||"",calls:0,ligacoes:0,custoUsd:0});
    a.calls+=r.calls;a.custoUsd+=r.custoUsd;if(r.op==="resumo")a.ligacoes+=r.calls;if(!a.usuario&&r.usuario)a.usuario=r.usuario});
  return Object.keys(m).map(function(k){return m[k]}).sort(function(a,b){return b.custoUsd-a.custoUsd});}

async function carregar(){
  var r;
  try{ r=await fetch("/api/admin/uso",{headers:{Authorization:"Bearer "+senha()}}); }
  catch(e){ document.getElementById("status").textContent="Falha de rede."; return; }
  if(r.status===401){ mostrarLogin("Senha incorreta."); return; }
  var d=await r.json();
  DADOS=d;
  document.getElementById("login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  if(CAMBIO==null){var ci=document.getElementById("cambio");if(ci&&!ci.value)ci.value=Number(d.cotacao||0).toFixed(2);}
  if(!d.configurado){document.getElementById("status").textContent="Storage (Upstash) ainda não configurado — os contadores começam a somar após configurar.";}
  else{document.getElementById("status").textContent="Consumo de tokens do Gemini (transcrição + resumo) e custo estimado.";}
  var agora=new Date();
  document.getElementById("atualizado").textContent="atualizado "+String(agora.getHours()).padStart(2,"0")+":"+String(agora.getMinutes()).padStart(2,"0");
  render();
  carregarFeedback();
}

function escFb(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
async function carregarFeedback(){
  var tb=document.getElementById("tbody-feedback");
  try{
    var r=await fetch("/api/admin/feedback",{headers:{Authorization:"Bearer "+senha()}});
    if(!r.ok){ if(tb)tb.innerHTML='<tr><td colspan="6" class="muted">Falha ao carregar feedback.</td></tr>'; return; }
    var d=await r.json();
    renderFeedback((d&&d.itens)||[]);
  }catch(e){ if(tb)tb.innerHTML='<tr><td colspan="6" class="muted">Falha de rede.</td></tr>'; }
}
function renderFeedback(itens){
  var st=document.getElementById("fb-stats");
  var tb=document.getElementById("tbody-feedback");
  if(!itens.length){ if(st)st.textContent="Sem feedback ainda."; if(tb)tb.innerHTML='<tr><td colspan="6" class="muted">Sem feedback ainda.</td></tr>'; return; }
  var up=0,down=0,editada=0,implic=0,dvC=0,dvA=0,dvS=0,dvE=0,tagCount={};
  itens.forEach(function(f){
    if(f.rating==="up")up++; if(f.rating==="down")down++;
    if(f.descEditada)editada++;
    if(f.tipo==="implicito"){implic++;var dv=f.divergencias||{};
      if(dv.clienteMudou)dvC++; if(dv.assuntoMudou)dvA++; if(dv.setorMudou)dvS++; if(dv.executorMudou)dvE++;}
    (f.tags||[]).forEach(function(t){tagCount[t]=(tagCount[t]||0)+1;});
  });
  var pct=function(n,d){return d>0?Math.round(n/d*100)+"%":"—";};
  var topTags=Object.keys(tagCount).sort(function(a,b){return tagCount[b]-tagCount[a];}).slice(0,4)
    .map(function(t){return escFb(t)+" ("+tagCount[t]+")";}).join(", ")||"—";
  if(st){st.innerHTML="<b>"+itens.length+"</b> feedbacks · 👍 <b>"+up+"</b> · 👎 <b>"+down+"</b> · descrição editada em <b>"+pct(editada,itens.length)+"</b> · divergência (dos "+implic+" implícitos): cliente "+pct(dvC,implic)+", assunto "+pct(dvA,implic)+", setor "+pct(dvS,implic)+", executor "+pct(dvE,implic)+" · tags: "+topTags;}
  if(tb){tb.innerHTML=itens.map(function(f){
    var data="";try{data=new Date(f.ts).toLocaleString("pt-BR");}catch(e){data=escFb(f.ts);}
    var aval=f.rating==="up"?"👍":(f.rating==="down"?"👎":(f.tipo==="implicito"?"(implícito)":"—"));
    var dv=f.divergencias||{};var divs=[];
    if(dv.assuntoMudou)divs.push("assunto: "+escFb(dv.assuntoSugerido||"?")+" → "+escFb(dv.assuntoFinal||"?"));
    if(dv.clienteMudou)divs.push("cliente trocado");
    if(dv.setorMudou)divs.push("setor trocado");
    if(dv.executorMudou)divs.push("executor trocado");
    if(f.descEditada)divs.push("descrição editada");
    (f.tags||[]).forEach(function(t){divs.push(escFb(t));});
    return "<tr><td>"+escFb(data)+"</td><td>"+escFb(f.usuario||f.ramal||"—")+"</td><td>"+escFb(f.origem||"—")+"</td><td>"+aval+"</td><td>"+(divs.join("; ")||"—")+"</td><td>"+escFb(f.comentario||"")+"</td></tr>";
  }).join("");}
}

function render(){
  if(!DADOS)return;
  var iv=intervalo();
  var rowsP=noPeriodo(DADOS.porDiaModelo,iv.de,iv.ate);
  var t=totais(rowsP);
  var c=cot();

  // KPIs
  document.getElementById("c-brl").textContent=fmtBRL.format(t.custoUsd*c);
  document.getElementById("c-usd").textContent=fmtUSD(t.custoUsd);
  document.getElementById("c-tok").textContent=fmtInt.format(t.inputTokens+t.outputTokens);
  document.getElementById("c-tok-s").textContent=fmtInt.format(t.inputTokens)+" in · "+fmtInt.format(t.outputTokens)+" out";
  document.getElementById("c-calls").textContent=fmtInt.format(t.calls);

  // Comparativo vs periodo anterior de mesmo tamanho (#3)
  var nDias=diffDias(iv.de,iv.ate)+1;
  var antAte=addDias(iv.de,-1),antDe=addDias(antAte,-(nDias-1));
  var custoAnt=totais(noPeriodo(DADOS.porDiaModelo,antDe,antAte)).custoUsd*c;
  var custoAtual=t.custoUsd*c;
  var brlS="câmbio R$ "+Number(c).toFixed(2);
  if(custoAnt>0){var delta=(custoAtual-custoAnt)/custoAnt*100;var up=delta>=0;
    brlS+=' · <span class="delta '+(up?"up":"down")+'">'+(up?"▲":"▼")+" "+Math.abs(delta).toFixed(0)+"% vs período anterior</span>";}
  document.getElementById("c-brl-s").innerHTML=brlS;

  // Projecao do mes (#4)
  var mesDe=primeiroDiaMes(),mesAte=hojeUTC();
  var custoMes=totais(noPeriodo(DADOS.porDiaModelo,mesDe,mesAte)).custoUsd*c;
  var decorridos=diffDias(mesDe,mesAte)+1;
  var proj=decorridos>0?custoMes/decorridos*ultimoDiaMes():0;
  document.getElementById("c-proj").textContent=fmtBRL.format(proj);
  document.getElementById("c-proj-s").textContent="mês até agora: "+fmtBRL.format(custoMes);

  // Por ligacao (periodo)
  var custoLig=(t.transcUsd+t.resumoUsd)*c;
  document.getElementById("l-count").textContent=fmtInt.format(t.ligacoes);
  document.getElementById("l-total").textContent=fmtBRL.format(custoLig);
  document.getElementById("l-total-s").textContent=fmtUSD(t.transcUsd+t.resumoUsd);
  document.getElementById("l-avg").textContent=fmtBRL4.format(t.ligacoes?custoLig/t.ligacoes:0);
  document.getElementById("l-avg-s").textContent=(t.ligacoes?fmtUSD((t.transcUsd+t.resumoUsd)/t.ligacoes):fmtUSD(0))+" / ligação";

  var accent=css("--accent"),brand=css("--brand-2"),gold=css("--gold"),muted=css("--muted"),grid="rgba(120,140,180,.14)";
  var dias=porDiaAgg(rowsP);

  // #2 Custo por dia (R$)
  chart("chartCustoDia",{type:"bar",data:{labels:dias.map(function(x){return x.dia.slice(5)}),datasets:[{data:dias.map(function(x){return +(x.custoUsd*c).toFixed(4)}),backgroundColor:accent,borderRadius:6}]},options:baseOpt(muted,grid,true)});

  // #6 Transcricao vs resumo (rosca, R$)
  chart("chartOp",{type:"doughnut",data:{labels:["Transcrição","Resumo"],datasets:[{data:[+(t.transcUsd*c).toFixed(4),+(t.resumoUsd*c).toFixed(4)],backgroundColor:[brand,gold],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:muted}}}}});

  // Custo por modelo (R$) no periodo
  var porModelo={};rowsP.forEach(function(r){porModelo[r.model]=(porModelo[r.model]||0)+r.custoUsd});
  var ml=Object.keys(porModelo).sort(function(a,b){return porModelo[b]-porModelo[a]});
  chart("chartModelo",{type:"bar",data:{labels:ml,datasets:[{data:ml.map(function(m){return +(porModelo[m]*c).toFixed(4)}),backgroundColor:brand,borderRadius:6}]},options:baseOpt(muted,grid,false)});

  // #9 Tendencia custo medio por ligacao
  chart("chartTend",{type:"line",data:{labels:dias.map(function(x){return x.dia.slice(5)}),datasets:[{label:"R$ / ligação",data:dias.map(function(x){return x.ligacoes?+((x.custoUsd*c)/x.ligacoes).toFixed(4):0}),borderColor:gold,backgroundColor:"rgba(224,169,59,.15)",fill:true,tension:.3}]},options:baseOpt(muted,grid,false)});

  // Ligacoes vs E-mails (por fonte)
  var fonteRows=noPeriodo(DADOS.porFonte,iv.de,iv.ate);
  var fAgg={};
  fonteRows.forEach(function(r){var a=fAgg[r.fonte]||(fAgg[r.fonte]={custoUsd:0,itens:0});a.custoUsd+=r.custoUsd;if(r.op==="resumo")a.itens+=r.calls;});
  var ligUsd=(fAgg["ligacao"]&&fAgg["ligacao"].custoUsd)||0;
  var emUsd=(fAgg["email"]&&fAgg["email"].custoUsd)||0;
  var resUsd=(fAgg["resumo"]&&fAgg["resumo"].custoUsd)||0;
  chart("chartFonte",{type:"doughnut",data:{labels:["Ligações","E-mails","Resumo (gravação)"],datasets:[{data:[+(ligUsd*c).toFixed(4),+(emUsd*c).toFixed(4),+(resUsd*c).toFixed(4)],backgroundColor:[accent,gold,"#2f9e6b"],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:muted}}}}});
  var totF=ligUsd+emUsd+resUsd;
  var fLinhas=[{nome:"Ligações",itens:(fAgg["ligacao"]&&fAgg["ligacao"].itens)||0,usd:ligUsd},{nome:"E-mails",itens:(fAgg["email"]&&fAgg["email"].itens)||0,usd:emUsd},{nome:"Resumo (gravação)",itens:(fAgg["resumo"]&&fAgg["resumo"].itens)||0,usd:resUsd}];
  var tbf=document.getElementById("tbody-fonte");
  if(tbf){
    if(totF<=0.0000001){tbf.innerHTML='<tr><td colspan="4" class="muted">Sem consumo marcado por fonte no período.</td></tr>';}
    else{tbf.innerHTML=fLinhas.map(function(x){var pct=totF>0?Math.round(x.usd/totF*100):0;return "<tr><td>"+x.nome+"</td><td class='right'>"+fmtInt.format(x.itens)+"</td><td class='right'>"+fmtBRL.format(x.usd*c)+"</td><td class='right'>"+pct+"%</td></tr>"}).join("");}
  }

  // #5 Por ramal/usuario
  var ramais=ramalAgg(noPeriodo(DADOS.porRamal,iv.de,iv.ate));
  var somaRamais=ramais.reduce(function(a,x){return a+x.custoUsd},0);
  var naoAtrib=t.custoUsd-somaRamais;
  var tbr=document.getElementById("tbody-ramal");
  if(!ramais.length&&naoAtrib<=0.0000001){tbr.innerHTML='<tr><td colspan="4" class="muted">Sem consumo atribuído a ramal no período.</td></tr>';}
  else{
    var html=ramais.map(function(x){return "<tr><td>"+(x.ramal||"—")+"</td><td>"+(x.usuario||"—")+"</td><td class='right'>"+fmtInt.format(x.ligacoes)+"</td><td class='right'>"+fmtBRL.format(x.custoUsd*c)+"</td></tr>"}).join("");
    if(naoAtrib>0.0000001)html+="<tr><td class='muted'>—</td><td class='muted'>não atribuído</td><td class='right muted'>—</td><td class='right muted'>"+fmtBRL.format(naoAtrib*c)+"</td></tr>";
    tbr.innerHTML=html;
  }

  // #8 Ranking dias mais caros
  var top=dias.slice().sort(function(a,b){return b.custoUsd-a.custoUsd}).slice(0,7);
  var rk=document.getElementById("ranking");
  rk.innerHTML=top.length?top.map(function(x){return "<li><span class='d'>"+x.dia+"</span><span>"+fmtBRL.format(x.custoUsd*c)+"</span></li>"}).join(""):'<li class="muted">Sem dados no período.</li>';

  // #7 Tabela custo por dia (ordenavel)
  renderTabelaDia(dias,c);

  // Detalhe por modelo+op (todo o periodo)
  var tb=document.getElementById("tbody");
  var linhas=DADOS.linhas||[];
  if(!linhas.length){tb.innerHTML='<tr><td colspan="7" class="muted">Nenhum uso registrado ainda.</td></tr>';}
  else{tb.innerHTML=linhas.map(function(l){return "<tr><td>"+l.model+"</td><td><span class='badge "+(l.op==="resumo"?"resumo":"")+"'>"+l.op+"</span></td><td class='right'>"+fmtInt.format(l.inputTokens)+"</td><td class='right'>"+fmtInt.format(l.outputTokens)+"</td><td class='right'>"+fmtInt.format(l.calls)+"</td><td class='right'>"+fmtUSD(l.custoUsd)+"</td><td class='right'>"+fmtBRL.format(l.custoUsd*c)+"</td></tr>"}).join("");}
}

function baseOpt(muted,grid,money){return {responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:muted},grid:{display:false}},y:{ticks:{color:muted},grid:{color:grid}}}}}

function renderTabelaDia(dias,c){
  var arr=dias.slice();
  arr.sort(function(a,b){
    var col=ORD.col,va,vb;
    if(col==="tokens"){va=a.inputTokens+a.outputTokens;vb=b.inputTokens+b.outputTokens;}
    else if(col==="dia"){va=a.dia;vb=b.dia;}
    else{va=a[col];vb=b[col];}
    if(va<vb)return -1*ORD.dir;if(va>vb)return 1*ORD.dir;return 0;
  });
  var tb=document.getElementById("tbody-dia");
  if(!arr.length){tb.innerHTML='<tr><td colspan="5" class="muted">Sem dados no período.</td></tr>';return;}
  tb.innerHTML=arr.map(function(x){return "<tr><td>"+x.dia+"</td><td class='right'>"+fmtInt.format(x.inputTokens+x.outputTokens)+"</td><td class='right'>"+fmtInt.format(x.calls)+"</td><td class='right'>"+fmtInt.format(x.ligacoes)+"</td><td class='right'>"+fmtBRL.format(x.custoUsd*c)+"</td></tr>"}).join("");
}

var charts={};
function chart(id,cfg){if(charts[id])charts[id].destroy();charts[id]=new Chart(document.getElementById(id),cfg)}

// ---- CSV (#11) ----
function baixar(nome,texto){var b=new Blob([texto],{type:"text/csv;charset=utf-8"});var u=URL.createObjectURL(b);var a=document.createElement("a");a.href=u;a.download=nome;a.click();setTimeout(function(){URL.revokeObjectURL(u)},1500);}
function csvDia(){if(!DADOS)return;var iv=intervalo(),c=cot();var dias=porDiaAgg(noPeriodo(DADOS.porDiaModelo,iv.de,iv.ate));
  var linhas=[["dia","tokens_entrada","tokens_saida","chamadas","ligacoes","custo_usd","custo_brl"]];
  dias.forEach(function(x){linhas.push([x.dia,x.inputTokens,x.outputTokens,x.calls,x.ligacoes,x.custoUsd.toFixed(6),(x.custoUsd*c).toFixed(4)])});
  baixar("custos_por_dia_"+iv.de+"_a_"+iv.ate+".csv",linhas.map(function(l){return l.join(";")}).join("\\n"));}
function csvRamal(){if(!DADOS)return;var iv=intervalo(),c=cot();var rs=ramalAgg(noPeriodo(DADOS.porRamal,iv.de,iv.ate));
  var linhas=[["ramal","usuario","ligacoes","chamadas","custo_usd","custo_brl"]];
  rs.forEach(function(x){linhas.push([x.ramal,x.usuario,x.ligacoes,x.calls,x.custoUsd.toFixed(6),(x.custoUsd*c).toFixed(4)])});
  baixar("custos_por_ramal_"+iv.de+"_a_"+iv.ate+".csv",linhas.map(function(l){return l.join(";")}).join("\\n"));}

// ---- controles ----
function selPeriodo(p){PERIODO.preset=p;
  var segs=document.querySelectorAll("#seg-periodo button");for(var i=0;i<segs.length;i++)segs[i].classList.toggle("on",segs[i].getAttribute("data-p")===p);
  document.getElementById("custom-range").classList.toggle("hidden",p!=="custom");
  render();}
(function(){var segs=document.querySelectorAll("#seg-periodo button");for(var i=0;i<segs.length;i++)segs[i].onclick=function(){selPeriodo(this.getAttribute("data-p"))};})();
document.getElementById("dt-de").onchange=function(){PERIODO.de=this.value||null;render()};
document.getElementById("dt-ate").onchange=function(){PERIODO.ate=this.value||null;render()};
document.getElementById("cambio").oninput=function(){var v=parseFloat(this.value);CAMBIO=isFinite(v)&&v>0?v:null;render()};
document.getElementById("csv-dia").onclick=csvDia;
document.getElementById("csv-ramal").onclick=csvRamal;
document.getElementById("auto").onchange=function(){if(this.checked){timerAuto=setInterval(carregar,300000)}else{clearInterval(timerAuto);timerAuto=null}};
(function(){var ths=document.querySelectorAll("#tbody-dia");
  var heads=document.querySelectorAll("th.sortable");for(var i=0;i<heads.length;i++)heads[i].onclick=function(){var col=this.getAttribute("data-col");if(ORD.col===col)ORD.dir*=-1;else{ORD.col=col;ORD.dir=col==="dia"?-1:-1;}if(DADOS)render();};})();

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

if(senha())carregar();
</script>
</body>
</html>`;
