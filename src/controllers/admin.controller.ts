import { Request, Response } from "express";
import { custoUsd, getUsdBrl } from "../services/pricing";
import { getRelatorioUso } from "../services/usage";

function senhaAdmin(): string {
  return process.env.ADMIN_PASSWORD || "Contas@2074";
}

function isAdmin(req: Request): boolean {
  const auth = req.header("authorization") || "";
  return auth === `Bearer ${senhaAdmin()}`;
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

  const linhas = relatorio.linhas
    .map((l) => ({
      ...l,
      custoUsd: custoUsd(l.model, l.inputTokens, l.outputTokens),
    }))
    .sort((a, b) => b.custoUsd - a.custoUsd);

  const porDia = relatorio.porDia.map((d) => {
    // custo do dia aproximado pela media dos modelos usados nas linhas do dia
    // (agregacao simples: usa preco por modelo aplicado ao total in/out do dia
    // nao e possivel sem detalhar por modelo/dia, entao estimamos pelo mix global)
    return d;
  });

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

  // Metricas por ligacao: cada ligacao gera 1 transcricao + 1 resumo, entao o
  // numero de ligacoes = chamadas da operacao "resumo" (uma por ligacao).
  const ligacoes = linhas
    .filter((l) => l.op === "resumo")
    .reduce((acc, l) => acc + l.calls, 0);
  const custoTranscricaoUsd = linhas
    .filter((l) => l.op === "transcricao")
    .reduce((acc, l) => acc + l.custoUsd, 0);
  const custoResumoUsd = linhas
    .filter((l) => l.op === "resumo")
    .reduce((acc, l) => acc + l.custoUsd, 0);
  const custoLigacoesUsd = custoTranscricaoUsd + custoResumoUsd;

  res.status(200).json({
    ok: true,
    configurado: relatorio.configurado,
    cotacao,
    totais: {
      ...totais,
      tokens: totais.inputTokens + totais.outputTokens,
      custoBrl,
    },
    porLigacao: {
      ligacoes,
      custoTotalUsd: custoLigacoesUsd,
      custoTotalBrl: custoLigacoesUsd * cotacao,
      custoMedioUsd: ligacoes ? custoLigacoesUsd / ligacoes : 0,
      custoMedioBrl: ligacoes ? (custoLigacoesUsd * cotacao) / ligacoes : 0,
      custoTranscricaoBrl: custoTranscricaoUsd * cotacao,
      custoResumoBrl: custoResumoUsd * cotacao,
    },
    linhas,
    porDia,
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
.topbar{display:flex;align-items:center;gap:16px;margin-bottom:26px}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:42px;height:42px;border-radius:11px;background:linear-gradient(135deg,var(--brand) 0%,var(--brand-2) 55%,var(--accent) 130%);display:grid;place-items:center;color:#fff;font-weight:800;font-size:18px;box-shadow:0 6px 16px rgba(11,61,102,.35)}
.name b{display:block;font-size:15px}.name span{font-size:12px;color:var(--muted)}
.spacer{flex:1}
.pill{font-size:12px;color:var(--muted);border:1px solid var(--border);padding:6px 12px;border-radius:999px}
.icon-btn{background:var(--card);border:1px solid var(--border);color:var(--text);width:40px;height:40px;border-radius:11px;cursor:pointer;font-size:16px}
h1{font-size:22px;margin-bottom:4px}.sub{color:var(--muted);font-size:13px;margin-bottom:22px}
.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:22px}
@media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}}
.card{background:linear-gradient(180deg,var(--card-2),var(--card));border:1px solid var(--border);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow);position:relative;overflow:hidden}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--border)}
.card.brand::before{background:var(--brand-2)}.card.accent::before{background:var(--accent)}.card.gold::before{background:var(--gold)}
.card .k{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.card .v{font-size:23px;font-weight:700;margin-top:8px}
.card .s{font-size:12px;color:var(--muted);margin-top:4px}
.card.accent .v{color:var(--accent)}.card.gold .v{color:var(--gold)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:22px}
@media(max-width:900px){.grid2{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;box-shadow:var(--shadow)}
.panel h3{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px}
.chart-box{position:relative;height:260px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.5px}
tbody tr:hover{background:var(--accent-soft)}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--accent-soft);color:var(--accent)}
.badge.resumo{background:rgba(224,169,59,.14);color:var(--gold)}
.right{text-align:right}
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
    <span class="pill" id="cotacao">cotação: —</span>
    <button class="icon-btn" id="tema" title="Alternar tema">☀️</button>
    <button class="icon-btn" id="refresh" title="Atualizar">↻</button>
  </div>

  <h1>Custos de Inteligência Artificial</h1>
  <div class="sub" id="status">Consumo de tokens do Gemini (transcrição + resumo) e custo estimado.</div>

  <div class="cards">
    <div class="card brand"><div class="k">Custo total (US$)</div><div class="v" id="c-usd">—</div><div class="s">preços de referência</div></div>
    <div class="card accent"><div class="k">Custo total (R$)</div><div class="v" id="c-brl">—</div><div class="s" id="c-brl-s"></div></div>
    <div class="card"><div class="k">Tokens (total)</div><div class="v" id="c-tok">—</div><div class="s" id="c-tok-s"></div></div>
    <div class="card"><div class="k">Chamadas de IA</div><div class="v" id="c-calls">—</div><div class="s">transcrição + resumo</div></div>
    <div class="card gold"><div class="k">Custo médio / chamada IA</div><div class="v" id="c-avg">—</div><div class="s">transcrição ou resumo</div></div>
  </div>

  <div class="panel" style="margin-bottom:22px">
    <h3>Por ligação (transcrição + resumo)</h3>
    <div class="cards" style="grid-template-columns:repeat(3,1fr);margin-bottom:0">
      <div class="card brand"><div class="k">Ligações resumidas</div><div class="v" id="l-count">—</div><div class="s">com resumo da IA</div></div>
      <div class="card accent"><div class="k">Custo total das ligações</div><div class="v" id="l-total">—</div><div class="s" id="l-total-s"></div></div>
      <div class="card gold"><div class="k">Custo médio por ligação</div><div class="v" id="l-avg">—</div><div class="s" id="l-avg-s">R$</div></div>
    </div>
  </div>

  <div class="grid2">
    <div class="panel"><h3>Tokens por dia</h3><div class="chart-box"><canvas id="chartDia"></canvas></div></div>
    <div class="panel"><h3>Custo por modelo (US$)</h3><div class="chart-box"><canvas id="chartModelo"></canvas></div></div>
  </div>

  <div class="panel">
    <h3>Detalhe por modelo e operação</h3>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>Modelo</th><th>Operação</th><th class="right">Tokens entrada</th><th class="right">Tokens saída</th><th class="right">Chamadas</th><th class="right">Custo US$</th><th class="right">Custo R$</th></tr></thead>
        <tbody id="tbody"><tr><td colspan="7" class="muted">Carregando…</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<script>
var THEME_KEY="painel-tema";
function setTheme(t){document.documentElement.setAttribute("data-theme",t);document.getElementById("tema").textContent=t==="dark"?"☀️":"🌙";try{localStorage.setItem(THEME_KEY,t)}catch(e){}}
setTheme((function(){try{return localStorage.getItem(THEME_KEY)||"dark"}catch(e){return "dark"}})());
document.getElementById("tema").onclick=function(){setTheme(document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark");if(window.__dados)render(window.__dados)};

var fmtBRL=new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL",minimumFractionDigits:2,maximumFractionDigits:4});
var fmtInt=new Intl.NumberFormat("pt-BR");
function fmtUSD(v){return "US$ "+Number(v||0).toFixed(4)}

function senha(){try{return sessionStorage.getItem("admin-pwd")||""}catch(e){return ""}}
function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}

var charts={};
function chart(id,cfg){if(charts[id])charts[id].destroy();charts[id]=new Chart(document.getElementById(id),cfg)}

async function carregar(){
  var r;
  try{ r=await fetch("/api/admin/uso",{headers:{Authorization:"Bearer "+senha()}}); }
  catch(e){ document.getElementById("status").textContent="Falha de rede."; return; }
  if(r.status===401){ mostrarLogin("Senha incorreta."); return; }
  var d=await r.json();
  window.__dados=d;
  document.getElementById("login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  if(!d.configurado){document.getElementById("status").textContent="Storage (Upstash) ainda não configurado — os contadores começam a somar após configurar.";}
  render(d);
}

function render(d){
  document.getElementById("cotacao").textContent="cotação: R$ "+Number(d.cotacao||0).toFixed(2);
  document.getElementById("c-usd").textContent=fmtUSD(d.totais.custoUsd);
  document.getElementById("c-brl").textContent=fmtBRL.format(d.totais.custoBrl);
  document.getElementById("c-brl-s").textContent="câmbio R$ "+Number(d.cotacao||0).toFixed(2);
  document.getElementById("c-tok").textContent=fmtInt.format(d.totais.tokens);
  document.getElementById("c-tok-s").textContent=fmtInt.format(d.totais.inputTokens)+" in · "+fmtInt.format(d.totais.outputTokens)+" out";
  document.getElementById("c-calls").textContent=fmtInt.format(d.totais.calls);
  var avg=d.totais.calls?d.totais.custoBrl/d.totais.calls:0;
  document.getElementById("c-avg").textContent=fmtBRL.format(avg);

  var pl=d.porLigacao||{ligacoes:0,custoTotalBrl:0,custoMedioBrl:0,custoMedioUsd:0};
  document.getElementById("l-count").textContent=fmtInt.format(pl.ligacoes||0);
  document.getElementById("l-total").textContent=fmtBRL.format(pl.custoTotalBrl||0);
  document.getElementById("l-total-s").textContent=fmtUSD(pl.custoTotalUsd||0);
  document.getElementById("l-avg").textContent=fmtBRL.format(pl.custoMedioBrl||0);
  document.getElementById("l-avg-s").textContent=fmtUSD(pl.custoMedioUsd||0)+" / ligação";

  var tb=document.getElementById("tbody");
  if(!d.linhas.length){tb.innerHTML='<tr><td colspan="7" class="muted">Nenhum uso registrado ainda.</td></tr>';}
  else{tb.innerHTML=d.linhas.map(function(l){return "<tr><td>"+l.model+"</td><td><span class='badge "+(l.op==="resumo"?"resumo":"")+"'>"+l.op+"</span></td><td class='right'>"+fmtInt.format(l.inputTokens)+"</td><td class='right'>"+fmtInt.format(l.outputTokens)+"</td><td class='right'>"+fmtInt.format(l.calls)+"</td><td class='right'>"+fmtUSD(l.custoUsd)+"</td><td class='right'>"+fmtBRL.format(l.custoUsd*d.cotacao)+"</td></tr>";}).join("");}

  var accent=css("--accent"),brand=css("--brand-2"),muted=css("--muted"),grid="rgba(120,140,180,.14)";
  var dia=d.porDia||[];
  chart("chartDia",{type:"line",data:{labels:dia.map(function(x){return x.dia.slice(5)}),datasets:[{label:"entrada",data:dia.map(function(x){return x.inputTokens}),borderColor:brand,backgroundColor:"rgba(18,87,143,.15)",fill:true,tension:.3},{label:"saída",data:dia.map(function(x){return x.outputTokens}),borderColor:accent,backgroundColor:"rgba(31,169,113,.15)",fill:true,tension:.3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:muted}}},scales:{x:{ticks:{color:muted},grid:{color:grid}},y:{ticks:{color:muted},grid:{color:grid}}}}});

  var porModelo={};d.linhas.forEach(function(l){porModelo[l.model]=(porModelo[l.model]||0)+l.custoUsd});
  var ml=Object.keys(porModelo);
  chart("chartModelo",{type:"bar",data:{labels:ml,datasets:[{data:ml.map(function(m){return porModelo[m]}),backgroundColor:accent,borderRadius:6}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:muted},grid:{display:false}},y:{ticks:{color:muted},grid:{color:grid}}}}});
}

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
