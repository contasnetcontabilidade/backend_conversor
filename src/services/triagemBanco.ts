// Onde a triagem de e-mails guarda o que precisa entre uma conferencia e
// outra: no Supabase (Postgres), pela API REST dele (PostgREST), com a chave
// secreta. As tabelas estao em supabase/triagem.sql.
//
// Saiu do Upstash (Redis) em 12/11/2026: o gratuito de la cobra por comando
// (500 mil por mes) e a triagem com todo mundo no piloto (~50 pessoas)
// passaria disso sozinha. No Supabase gratuito o limite e de espaco (500 MB)
// e de trafego (5 GB/mes), nao de comando. Por isso o "robozinho" (176 KB,
// triagemModelo.ts) ficou no Redis: baixado a cada conferencia, gastaria o
// trafego daqui.
//
// Sem o @supabase/supabase-js de proposito: a versao atual pede Node 22, e
// estas chamadas REST simples nao justificam arriscar o deploy da Vercel.
//
// Os testes trocam o banco por um em memoria (usarBancoDeTeste).

export interface ContaDaTriagem {
  janela: number; // ms; 0 = conta nova (a conferencia olha o ultimo dia)
  vistas: string[];
  dispensas: number;
}

export interface UsoDaTriagem {
  dia: string; // YYYY-MM-DD (UTC)
  modelo: string;
  op: string;
  inputTokens: number;
  outputTokens: number;
  chamadas: number;
}

export interface BancoDaTriagem {
  estaNoPiloto(conta: string): Promise<boolean>;
  listarPiloto(): Promise<string[]>;
  entrarNoPiloto(conta: string): Promise<void>;
  sairDoPiloto(conta: string): Promise<void>;
  lerConta(conta: string): Promise<ContaDaTriagem>;
  gravarCursor(conta: string, janela: number, vistas: string[]): Promise<void>;
  /** "Nao e chamado" soma uma dispensa; zerar = "virou chamado". */
  contarDispensa(conta: string, zerar: boolean): Promise<void>;
  lerBandeja(conta: string): Promise<unknown[]>;
  gravarSugestao(conta: string, threadId: string, dados: object): Promise<void>;
  /** false = nao havia sugestao dessa conversa. */
  tirarSugestao(conta: string, threadId: string): Promise<boolean>;
  /** true so para quem marcou primeiro: e o que segura 2 PCs da mesma pessoa. */
  marcarFeito(conta: string, messageId: string, expiraEm: Date): Promise<boolean>;
  estaEncerrada(conta: string, threadId: string): Promise<boolean>;
  encerrar(conta: string, threadId: string, expiraEm: Date): Promise<void>;
  /** O texto JSON exato: a copia para analise compara pelo hash do texto. */
  registrar(registro: string): Promise<void>;
  somarUso(uso: Omit<UsoDaTriagem, "chamadas">): Promise<void>;
  lerUso(): Promise<UsoDaTriagem[]>;
  limparVencidos(): Promise<void>;
}

// Uma conferencia faz varias chamadas; uma que trava nao pode segurar a
// funcao da Vercel ate o limite dela.
const TEMPO_MS = 10_000;

export function criarBancoSupabase(url: string, chave: string): BancoDaTriagem {
  const base = url.replace(/\/+$/, "");
  // As chaves novas do Supabase (sb_secret_...) vao so no apikey: nao sao JWT,
  // e no Authorization seriam recusadas. As antigas (service_role, um JWT)
  // precisam dos dois cabecalhos.
  const autorizacao: Record<string, string> = chave.startsWith("sb_")
    ? { apikey: chave }
    : { apikey: chave, Authorization: `Bearer ${chave}` };
  const eq = (v: string) => `eq.${encodeURIComponent(v)}`;

  async function pedir(
    caminho: string,
    opcoes: { metodo?: string; prefer?: string; corpo?: unknown } = {},
  ): Promise<unknown> {
    const metodo = opcoes.metodo || "GET";
    const resposta = await fetch(`${base}/rest/v1/${caminho}`, {
      method: metodo,
      headers: {
        ...autorizacao,
        "Content-Type": "application/json",
        ...(opcoes.prefer ? { Prefer: opcoes.prefer } : {}),
      },
      body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
      signal: AbortSignal.timeout(TEMPO_MS),
    });
    const texto = await resposta.text();
    if (!resposta.ok) {
      // So o nome da tabela: os filtros da URL levam o e-mail da pessoa.
      const alvo = caminho.split("?")[0];
      throw new Error(`Supabase respondeu ${resposta.status} em ${metodo} ${alvo}: ${texto.slice(0, 300)}`);
    }
    return texto ? JSON.parse(texto) : null;
  }
  const linhas = async (caminho: string, opcoes?: Parameters<typeof pedir>[1]) => {
    const r = await pedir(caminho, opcoes);
    return Array.isArray(r) ? (r as Record<string, unknown>[]) : [];
  };
  const upsert = (tabela: string, conflito: string, corpo: unknown) =>
    pedir(`${tabela}?on_conflict=${conflito}`, {
      metodo: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      corpo,
    });

  return {
    async estaNoPiloto(conta) {
      return (await linhas(`triagem_piloto?select=conta&conta=${eq(conta)}`)).length > 0;
    },
    async listarPiloto() {
      return (await linhas("triagem_piloto?select=conta&order=conta")).map((l) => String(l.conta));
    },
    async entrarNoPiloto(conta) {
      await pedir("triagem_piloto?on_conflict=conta", {
        metodo: "POST",
        prefer: "resolution=ignore-duplicates,return=minimal",
        corpo: { conta },
      });
    },
    async sairDoPiloto(conta) {
      await pedir(`triagem_piloto?conta=${eq(conta)}`, { metodo: "DELETE", prefer: "return=minimal" });
    },
    async lerConta(conta) {
      const [l] = await linhas(`triagem_conta?select=janela_ms,vistas,dispensas&conta=${eq(conta)}`);
      return {
        janela: Number(l?.janela_ms) || 0,
        vistas: Array.isArray(l?.vistas) ? (l.vistas as unknown[]).map(String) : [],
        dispensas: Number(l?.dispensas) || 0,
      };
    },
    async gravarCursor(conta, janela, vistas) {
      await upsert("triagem_conta", "conta", {
        conta,
        janela_ms: janela,
        vistas,
        atualizado_em: new Date().toISOString(),
      });
    },
    async contarDispensa(conta, zerar) {
      await pedir("rpc/triagem_dispensa", { metodo: "POST", corpo: { p_conta: conta, p_zerar: zerar } });
    },
    async lerBandeja(conta) {
      return (await linhas(`triagem_sugestao?select=dados&conta=${eq(conta)}`)).map((l) => l.dados);
    },
    async gravarSugestao(conta, threadId, dados) {
      await upsert("triagem_sugestao", "conta,thread_id", { conta, thread_id: threadId, dados });
    },
    async tirarSugestao(conta, threadId) {
      const apagadas = await linhas(
        `triagem_sugestao?select=thread_id&conta=${eq(conta)}&thread_id=${eq(threadId)}`,
        { metodo: "DELETE", prefer: "return=representation" },
      );
      return apagadas.length > 0;
    },
    async marcarFeito(conta, messageId, expiraEm) {
      // ON CONFLICT DO NOTHING: a linha so volta para quem inseriu.
      const inseridas = await linhas("triagem_feito?on_conflict=conta,message_id&select=message_id", {
        metodo: "POST",
        prefer: "resolution=ignore-duplicates,return=representation",
        corpo: { conta, message_id: messageId, expira_em: expiraEm.toISOString() },
      });
      return inseridas.length > 0;
    },
    async estaEncerrada(conta, threadId) {
      const agora = encodeURIComponent(new Date().toISOString());
      const achadas = await linhas(
        `triagem_encerrada?select=thread_id&conta=${eq(conta)}&thread_id=${eq(threadId)}&expira_em=gt.${agora}`,
      );
      return achadas.length > 0;
    },
    async encerrar(conta, threadId, expiraEm) {
      await upsert("triagem_encerrada", "conta,thread_id", {
        conta,
        thread_id: threadId,
        expira_em: expiraEm.toISOString(),
      });
    },
    async registrar(registro) {
      await pedir("triagem_registro", { metodo: "POST", prefer: "return=minimal", corpo: { registro } });
    },
    async somarUso(uso) {
      await pedir("rpc/triagem_somar_uso", {
        metodo: "POST",
        corpo: {
          p_dia: uso.dia,
          p_modelo: uso.modelo,
          p_op: uso.op,
          p_in: uso.inputTokens,
          p_out: uso.outputTokens,
        },
      });
    },
    async lerUso() {
      // Uma linha por dia+modelo+op: o limite de 1000 linhas da API so pesa
      // daqui a anos.
      const l = await linhas(
        "triagem_uso?select=dia,modelo,op,input_tokens,output_tokens,chamadas&order=dia",
      );
      return l.map((u) => ({
        dia: String(u.dia),
        modelo: String(u.modelo),
        op: String(u.op),
        inputTokens: Number(u.input_tokens) || 0,
        outputTokens: Number(u.output_tokens) || 0,
        chamadas: Number(u.chamadas) || 0,
      }));
    },
    async limparVencidos() {
      const agora = encodeURIComponent(new Date().toISOString());
      for (const tabela of ["triagem_feito", "triagem_encerrada"]) {
        await pedir(`${tabela}?expira_em=lt.${agora}`, { metodo: "DELETE", prefer: "return=minimal" });
      }
    },
  };
}

let bancoAtual: BancoDaTriagem | null = null;

export function bancoDaTriagem(): BancoDaTriagem {
  if (bancoAtual) return bancoAtual;
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SECRET_KEY;
  if (!url || !chave) {
    // Sem banco nao ha cursor nem "feito": a conferencia leria a caixa e
    // pagaria a IA de novo a cada vez. Melhor falhar visivel.
    throw new Error("Triagem sem Supabase configurado (SUPABASE_URL/SUPABASE_SECRET_KEY).");
  }
  bancoAtual = criarBancoSupabase(url, chave);
  return bancoAtual;
}

/** So para os testes: troca o banco (null volta ao Supabase do .env). */
export function usarBancoDeTeste(banco: BancoDaTriagem | null): void {
  bancoAtual = banco;
}
