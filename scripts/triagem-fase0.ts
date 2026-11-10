// Fase 0 da triagem de e-mails: roda a triagem no HISTORICO das caixas e
// compara com os chamados de e-mail que foram criados de verdade (feedback
// implicito, id = threadId ou messageId). Responde, antes de ligar para alguem:
// quantos chamados reais a triagem acharia e quantos alarmes falsos daria.
//
// Uso (na pasta do backend):
//   ENV_FILE=../.env npx tsx scripts/triagem-fase0.ts \
//     --contas "a@contas.com.br=Suporte,b@contas.com.br=Departamento Pessoal" \
//     [--desde 2026-07-21] [--so-contar] [--amostra 600] [--paralelo 4] [--saida <pasta>]
//
// --so-contar: lista as conversas e acha os chamados de cada caixa, sem IA.
// --amostra N: tria todos os chamados reais + N conversas sorteadas das demais;
//   os alarmes falsos sao extrapolados para a caixa inteira.
//
// Privacidade (decisao do dono em 10/11/2026: guardar resultado + trecho): o
// assunto e o trecho vao SO para o arquivo da --saida (fora do git). Na tela
// sai apenas contagem.
import dotenv from "dotenv";
import { createWriteStream, mkdirSync, writeFileSync } from "fs";
import path from "path";
import type { MensagemParaTriagem } from "../src/services/gmailApi";

dotenv.config({ path: process.env.ENV_FILE || ".env" });

const SAIDA_PADRAO = path.resolve(
  process.env.USERPROFILE || process.env.HOME || ".",
  "Desktop/Database/data/fase0",
);
// Abas do Gmail que quase nunca tem pedido de cliente. Ficam fora da busca para
// nao pagar IA em propaganda; o resumo conta quantos chamados reais caem
// nelas, que e o custo desse filtro.
const FORA_DA_BUSCA = ["promotions", "social", "forums"];
const PRAZO_GMAIL_MS = 60_000;
const RAMAL_TESTE = "258"; // gasto de teste entra no painel com o ramal 258
const DIA_MS = 86_400_000;

type Conta = { email: string; setor?: string };

function args() {
  const a = process.argv.slice(2);
  const val = (nome: string) => {
    const i = a.indexOf(`--${nome}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const contas: Conta[] = String(val("contas") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [email, setor] = s.split("=");
      return { email: email.trim().toLowerCase(), setor: setor?.trim() || undefined };
    });
  if (!contas.length) throw new Error('Informe --contas "email=Setor,..."');
  const desde = val("desde") || "2026-07-21";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new Error("--desde no formato AAAA-MM-DD");
  return {
    contas,
    desde,
    soContar: a.includes("--so-contar"),
    amostra: Number(val("amostra")) || 0,
    paralelo: Math.min(8, Math.max(1, Number(val("paralelo")) || 4)),
    saida: path.resolve(val("saida") || SAIDA_PADRAO),
  };
}

function comPrazo<T>(p: Promise<T>, ms: number, oque: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const prazo = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${oque}: sem resposta em ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, prazo]).finally(() => clearTimeout(timer));
}

const httpStatus = (e: unknown) => Number(/HTTP (\d{3})/.exec(String((e as Error)?.message))?.[1]) || 0;
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

// O Google limita cada PESSOA a 6.000 "unidades de consulta" por minuto, e o
// app usa o mesmo limite: estourar deixa a aba E-mails da pessoa com erro
// naquele minuto. Na 1a rodada (10/11/2026) a listagem sozinha estourou e o
// Google respondeu 403 rateLimitExceeded, que nao e falta de permissao.
// Por isso as chamadas saem espacadas e, se estourar mesmo assim, o script
// espera o minuto virar e passa a ir mais devagar. O Google nao diz quanto
// cada chamada pesa nesse limite: com 250 ms entre chamadas ainda estourou 4
// vezes em 3 minutos, entao o intervalo se ajusta pelo que acontece.
let intervaloGmailMs = 600;
const INTERVALO_MAXIMO_MS = 5_000;
const ESPERA_LIMITE_MS = 65_000;
let proximaChamada = 0;
let esperasPorLimite = 0;

function ehLimiteDeTaxa(e: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const erro = (e as { details?: any })?.details?.error;
  const motivo = String(erro?.errors?.[0]?.reason || "");
  return httpStatus(e) === 429 || /rateLimitExceeded/i.test(motivo);
}

async function minhaVez() {
  const agora = Date.now();
  const vez = Math.max(agora, proximaChamada);
  proximaChamada = vez + intervaloGmailMs;
  if (vez > agora) await esperar(vez - agora);
}

// So repete o que e passageiro: limite de taxa e erro do lado do Google.
async function gmail<T>(fn: () => Promise<T>, oque: string): Promise<T> {
  for (let tentativa = 1; ; tentativa++) {
    await minhaVez();
    try {
      return await comPrazo(fn(), PRAZO_GMAIL_MS, oque);
    } catch (e) {
      if (ehLimiteDeTaxa(e) && tentativa <= 8) {
        esperasPorLimite++;
        intervaloGmailMs = Math.min(INTERVALO_MAXIMO_MS, Math.round(intervaloGmailMs * 1.5));
        console.warn(
          `[fase0] limite do Gmail em "${oque}"; esperando o minuto virar e indo a 1 chamada a cada ${intervaloGmailMs} ms (${esperasPorLimite}a vez)`,
        );
        proximaChamada = Math.max(proximaChamada, Date.now() + ESPERA_LIMITE_MS);
        continue;
      }
      if (httpStatus(e) >= 500 && tentativa < 4) {
        await esperar(2000 * 2 ** tentativa);
        continue;
      }
      throw e;
    }
  }
}

async function emParalelo<T>(itens: T[], n: number, fn: (x: T) => Promise<void>) {
  let prox = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, itens.length) }, async () => {
      while (prox < itens.length) await fn(itens[prox++]);
    }),
  );
}

// Sorteio repetivel: rodar de novo com outro prompt compara as MESMAS conversas.
function sortear<T>(itens: T[], n: number, semente: string): T[] {
  let s = [...semente].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const copia = [...itens];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia.slice(0, n);
}

function diasUteis(deMs: number, ateMs: number): number {
  let n = 0;
  for (let t = deMs; t < ateMs; t += DIA_MS) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n++;
  }
  return Math.max(1, n);
}

async function main() {
  const opt = args();
  // Import depois do dotenv: os servicos leem o ambiente ao carregar.
  const { listarFeedback } = await import("../src/services/feedback");
  const gm = await import("../src/services/gmailApi");
  const tri = await import("../src/services/triagem");
  const { recordUsage } = await import("../src/services/usage");
  const { CLAUDE_MODEL } = await import("../src/services/claude");
  const { custoUsd } = await import("../src/services/pricing");

  const desdeMs = Date.parse(`${opt.desde}T00:00:00-03:00`);
  const agora = Date.now();
  const carimbo = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  mkdirSync(opt.saida, { recursive: true });

  // Gabarito: os chamados de e-mail criados de verdade.
  const criados = new Map<string, { ts: string; ramal: string; usuario: string }>();
  for (const f of await listarFeedback()) {
    if (f.origem === "email" && f.tipo === "implicito" && f.id && !criados.has(f.id)) {
      criados.set(f.id, { ts: f.ts, ramal: String(f.ramal || ""), usuario: String(f.usuario || "") });
    }
  }
  console.log(`Chamados de e-mail no feedback: ${criados.size}`);

  const resumo: Record<string, unknown> = {
    versaoPrompt: tri.TRIAGEM_PROMPT_VERSION,
    desde: opt.desde,
    ate: new Date(agora).toISOString().slice(0, 10),
    diasUteis: diasUteis(desdeMs, agora),
    contas: [] as unknown[],
  };

  for (const conta of opt.contas) {
    console.log(`\n== ${conta.email} (${conta.setor || "sem setor"})`);
    try {
      await medirConta(conta);
    } catch (e) {
      // Conta sem acesso (nao conectada, permissao revogada) nao derruba as outras.
      console.error(`[fase0] ${conta.email} pulada: ${(e as Error).message}`);
      (resumo.contas as unknown[]).push({ conta: conta.email, erro: (e as Error).message });
    }
  }

  const arqResumo = path.join(opt.saida, `resumo-${carimbo}${opt.soContar ? "-contagem" : ""}.json`);
  writeFileSync(arqResumo, JSON.stringify(resumo, null, 2));
  console.log(`\nResumo: ${arqResumo}`);

  async function medirConta(conta: Conta) {
    // Uma listagem so, ja sem as abas excluidas: cada pagina de busca pesa no
    // limite do Google.
    const q = `after:${opt.desde.replace(/-/g, "/")} -in:chats ${FORA_DA_BUSCA.map((c) => `-category:${c}`).join(" ")}`;
    const naBusca = new Set<string>();
    let pagina: string | undefined;
    do {
      const r = await gmail(() => gm.buscarThreads(conta.email, q, pagina), "listar conversas");
      r.ids.forEach((id) => naBusca.add(id));
      pagina = r.proxima;
    } while (pagina);
    console.log(`Conversas no periodo (sem Promocoes/Social/Forums): ${naBusca.size}`);

    // Quais chamados criados sao desta caixa. Os ids do Gmail sao por caixa: o
    // que nao existe aqui da 404 (ou 400) e e de outra pessoa. UMA consulta por
    // chamado: o id da conversa e o id da 1a mensagem dela, entao buscar como
    // mensagem acha os dois casos (conversa inteira e "Separar mensagens").
    // Se a 1a mensagem foi apagada, esse chamado nao entra na conta.
    const cache = new Map<string, MensagemParaTriagem[]>();
    const positivos = new Map<string, { ts: string; ramal: string; usuario: string }>();
    await emParalelo([...criados.entries()], opt.paralelo, async ([id, info]) => {
      try {
        const m = await gmail(() => gm.obterEmail(conta.email, id), "ler e-mail");
        if (m.threadId) positivos.set(m.threadId, info);
      } catch (e) {
        if (![400, 404].includes(httpStatus(e))) throw e;
      }
    });
    // Dois motivos para um chamado real ficar sem triagem: a conversa e anterior
    // ao periodo (nao conta contra a triagem) ou caiu numa aba que a busca
    // exclui (esse e o custo do filtro).
    const foraDoPeriodo: string[] = [];
    const foraPorAba: string[] = [];
    await emParalelo([...positivos.keys()], opt.paralelo, async (threadId) => {
      const msgs = await gmail(() => gm.obterThreadParaTriagem(conta.email, threadId), "ler conversa");
      cache.set(threadId, msgs);
      if (!msgs.some((m) => m.quando >= desdeMs)) foraDoPeriodo.push(threadId);
      else if (!naBusca.has(threadId)) foraPorAba.push(threadId);
    });
    const usuarios = [...new Set([...positivos.values()].map((p) => p.usuario || "?"))];
    console.log(
      `Chamados criados desta caixa: ${positivos.size} (antes do periodo: ${foraDoPeriodo.length}; em aba excluida: ${foraPorAba.length}; criados por: ${usuarios.join(", ") || "-"})`,
    );

    const outrasNaBusca = [...naBusca].filter((t) => !positivos.has(t));
    const sorteadas = opt.amostra ? sortear(outrasNaBusca, opt.amostra, conta.email) : outrasNaBusca;
    const fator = sorteadas.length ? outrasNaBusca.length / sorteadas.length : 1;
    const alvo = [...[...positivos.keys()].filter((t) => naBusca.has(t)), ...sorteadas];

    if (opt.soContar) {
      // ~1,4 gatilho por conversa e ~1.100 tokens de entrada por triagem
      // (prompt fixo + trecho); a saida inclui o raciocinio curto do "low".
      const est = custoUsd(CLAUDE_MODEL, alvo.length * 1.4 * 1100, alvo.length * 1.4 * 250);
      console.log(`Seriam triadas: ${alvo.length} conversas (~US$ ${est.toFixed(2)} de IA)`);
      (resumo.contas as unknown[]).push({
        conta: conta.email,
        naBusca: naBusca.size,
        chamados: positivos.size,
        chamadosAntesDoPeriodo: foraDoPeriodo.length,
        chamadosEmAbaExcluida: foraPorAba.length,
        aTriar: alvo.length,
        custoEstimadoUsd: Number(est.toFixed(2)),
      });
      return;
    }

    const marcadorId = await gmail(() => gm.resolverMarcadorId(conta.email), "marcador").catch(() => "");
    const arquivo = path.join(opt.saida, `fase0-${conta.email}-${carimbo}.jsonl`);
    const out = createWriteStream(arquivo, { encoding: "utf-8" });
    let inTok = 0;
    let outTok = 0;
    let custo = 0;
    let feitas = 0;
    let erros = 0;
    const linhas: Array<{ gatilho: string; virou: boolean; decisao?: string; confianca?: number }> = [];
    const semGatilho: string[] = [];

    try {
      await emParalelo(alvo, opt.paralelo, async (threadId) => {
        let msgs = cache.get(threadId);
        try {
          msgs ??= await gmail(() => gm.obterThreadParaTriagem(conta.email, threadId), "ler conversa");
        } catch (e) {
          erros++;
          console.warn(`[fase0] conversa ilegivel (${httpStatus(e) || "rede"}): ${(e as Error).message}`);
          return;
        }
        const virou = positivos.has(threadId);
        const chamado = positivos.get(threadId);
        const gatilhos = tri.gatilhosDaThread(
          msgs.map((m) => tri.paraTriagem(m, conta.email)),
          desdeMs,
        );
        if (virou && !gatilhos.length) semGatilho.push(threadId);
        const rotulos = [...new Set(msgs.flatMap((m) => m.labelIds))];
        for (const g of gatilhos) {
          const trecho = tri.montarTrecho(g);
          const assunto = msgs.find((m) => m.id === g.recebida.id)?.subject || msgs[0]?.subject || "";
          const base = {
            conta: conta.email,
            setor: conta.setor || "",
            threadId,
            gatilho: g.tipo,
            quando: new Date(g.quando).toISOString(),
            assunto,
            remetenteDominio: g.recebida.fromEmail.split("@")[1] || "",
            abaGmail: rotulos.filter((l) => l.startsWith("CATEGORY_")),
            marcadoChamado: !!marcadorId && rotulos.includes(marcadorId),
            virouChamado: virou,
            chamadoTeste: chamado?.ramal === RAMAL_TESTE,
            chamadoEm: chamado?.ts || "",
            trecho,
            versaoPrompt: tri.TRIAGEM_PROMPT_VERSION,
            modelo: CLAUDE_MODEL,
          };
          try {
            const r = await tri.triarEmail({ setor: conta.setor, assunto, gatilho: g, trecho });
            inTok += r.inputTokens;
            outTok += r.outputTokens;
            custo += custoUsd(r.modeloCusto, r.inputTokens, r.outputTokens);
            const { inputTokens, outputTokens, modeloCusto, ...decisao } = r;
            out.write(JSON.stringify({ ...base, ...decisao, inputTokens, outputTokens }) + "\n");
            linhas.push({ gatilho: g.tipo, virou, decisao: r.decisao, confianca: r.confianca });
          } catch (e) {
            erros++;
            if (e instanceof tri.FalhaTriagem) {
              inTok += e.inputTokens;
              outTok += e.outputTokens;
              custo += custoUsd(e.modeloCusto || CLAUDE_MODEL, e.inputTokens, e.outputTokens);
            }
            out.write(JSON.stringify({ ...base, erro: (e as Error).message }) + "\n");
            linhas.push({ gatilho: g.tipo, virou });
            console.warn(`[fase0] triagem falhou: ${(e as Error).message}`);
          }
        }
        if (++feitas % 100 === 0) {
          console.log(`  ${feitas}/${alvo.length} conversas · US$ ${custo.toFixed(3)} · erros ${erros}`);
        }
      });
    } finally {
      out.end();
      // Mesmo se a rodada quebrar no meio, o que ja foi gasto vai para o painel,
      // num registro so por caixa (um por triagem gastaria milhares de comandos
      // do Redis). Sem `usuario`: o painel guarda o nome do ramal pelo ultimo
      // registro, e o 258 passaria a se chamar "Fase 0". Sem `fonte`: "email"
      // misturaria a triagem com o custo dos chamados de e-mail.
      if (inTok || outTok) {
        await recordUsage({
          model: CLAUDE_MODEL,
          op: "resumo",
          inputTokens: inTok,
          outputTokens: outTok,
          ramal: RAMAL_TESTE,
        }).catch((e) => console.warn(`[fase0] gasto NAO registrado no painel: ${(e as Error).message}`));
        console.log(`Gasto registrado no painel (ramal ${RAMAL_TESTE}): US$ ${custo.toFixed(4)}`);
      }
    }

    const dias = resumo.diasUteis as number;
    const porGatilho: Record<string, unknown> = {};
    for (const tipo of ["chegada", "resposta"]) {
      const l = linhas.filter((x) => x.gatilho === tipo && x.decisao);
      const reais = l.filter((x) => x.virou);
      const corte = (min: number) => {
        const sim = l.filter((x) => x.decisao === "sim" && (x.confianca ?? 0) >= min);
        const achados = sim.filter((x) => x.virou).length;
        const alarmes = Math.round(sim.filter((x) => !x.virou).length * fator);
        return {
          confiancaMinima: min,
          achados,
          acerto: reais.length ? Number((achados / reais.length).toFixed(3)) : null,
          alarmesFalsos: alarmes,
          alarmesPorDiaUtil: Number((alarmes / dias).toFixed(1)),
        };
      };
      porGatilho[tipo] = {
        triagens: l.length,
        chamadosReais: reais.length,
        cortes: [0, 0.5, 0.7, 0.9].map(corte),
      };
    }
    const linhaResumo = {
      conta: conta.email,
      setor: conta.setor || "",
      naBusca: naBusca.size,
      chamados: positivos.size,
      chamadosAntesDoPeriodo: foraDoPeriodo.length,
      chamadosEmAbaExcluida: foraPorAba.length,
      chamadosSemGatilho: semGatilho.length,
      triadas: alvo.length,
      amostra: opt.amostra ? { sorteadas: sorteadas.length, fatorDosAlarmes: Number(fator.toFixed(2)) } : null,
      porGatilho,
      erros,
      esperasPeloLimiteDoGmail: esperasPorLimite,
      intervaloFinalGmailMs: intervaloGmailMs,
      tokens: { entrada: inTok, saida: outTok },
      custoUsd: Number(custo.toFixed(4)),
      arquivo,
    };
    (resumo.contas as unknown[]).push(linhaResumo);
    console.log(JSON.stringify({ ...linhaResumo, arquivo: undefined }, null, 2));
  }
}

main().catch((e) => {
  console.error(`[fase0] parou: ${(e as Error).message}`);
  process.exit(1);
});
