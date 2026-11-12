-- Triagem de e-mails (sugestões de chamado) no Supabase.
--
-- Até 12/11/2026 isto morava no Upstash (Redis). O gratuito de lá cobra por
-- comando (500 mil por mês), e a triagem com todo mundo no piloto (~50
-- pessoas) passaria disso sozinha. Aqui o limite é de espaço (500 MB), não de
-- comando. Ver src/services/triagemPiloto.ts.
--
-- Só o backend acessa, com a chave secreta (papel service_role, que ignora o
-- RLS). O projeto foi criado sem "expor tabelas novas automaticamente": nenhum
-- papel ganha acesso sozinho, por isso os GRANT no fim são só para o
-- service_role. O RLS fica ligado e sem política: a chave publicável não lê
-- nem grava nada, nem se alguém der GRANT por engano.
--
-- Rodar no SQL Editor do Supabase. Pode rodar de novo sem estragar.

-- Quem está no piloto (era o SET triagem:piloto).
create table if not exists public.triagem_piloto (
  conta text primary key, -- e-mail da conta Google, em minúsculas
  entrou_em timestamptz not null default now()
);

-- Onde a próxima conferência começa e o limiar da pessoa (eram as chaves
-- triagem:cursor e triagem:dispensas). "vistas": as conversas da janela já
-- vistas enquanto ela não foi vista inteira.
create table if not exists public.triagem_conta (
  conta text primary key,
  janela_ms bigint not null default 0,
  vistas text[] not null default '{}',
  dispensas integer not null default 0,
  atualizado_em timestamptz not null default now()
);

-- A bandeja: sugestões pendentes (era o hash triagem:sug:<conta>). "dados" é
-- a SugestaoTriagem do jeito que o app recebe.
create table if not exists public.triagem_sugestao (
  conta text not null,
  thread_id text not null,
  dados jsonb not null,
  primary key (conta, thread_id)
);

-- E-mail que já passou pela triagem. O insert que não entra (chave repetida)
-- é o que impede dois PCs da mesma pessoa de pagarem a IA duas vezes pelo
-- mesmo e-mail. expira_em só serve para a limpeza: a busca nunca volta 30
-- dias atrás.
create table if not exists public.triagem_feito (
  conta text not null,
  message_id text not null,
  expira_em timestamptz not null,
  primary key (conta, message_id)
);

-- Conversa com desfecho: não volta a ser sugerida até expira_em (30 dias).
create table if not exists public.triagem_encerrada (
  conta text not null,
  thread_id text not null,
  expira_em timestamptz not null,
  primary key (conta, thread_id)
);

-- O que ia para triagem:list. A cópia para análise (Desktop\Database) leva
-- para o DuckDB e apaga daqui o que já copiou, menos o mais novo. "registro" é
-- o texto JSON exato, não jsonb: a cópia reconhece o que já tem pelo hash do
-- texto, e o jsonb reordenaria as chaves.
create table if not exists public.triagem_registro (
  id bigint generated always as identity primary key,
  registro text not null
);

-- Gasto de IA da triagem por dia (UTC, como o uso:d do Redis). O /admin soma
-- com o que está no Redis.
create table if not exists public.triagem_uso (
  dia date not null,
  modelo text not null,
  op text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  chamadas integer not null default 0,
  primary key (dia, modelo, op)
);

alter table public.triagem_piloto enable row level security;
alter table public.triagem_conta enable row level security;
alter table public.triagem_sugestao enable row level security;
alter table public.triagem_feito enable row level security;
alter table public.triagem_encerrada enable row level security;
alter table public.triagem_registro enable row level security;
alter table public.triagem_uso enable row level security;

-- Soma o gasto de uma conferência no dia. O upsert da API troca o valor em
-- vez de somar, e duas conferências ao mesmo tempo perderiam uma das somas.
create or replace function public.triagem_somar_uso(
  p_dia date,
  p_modelo text,
  p_op text,
  p_in bigint,
  p_out bigint
) returns void
language sql
set search_path = ''
as $$
  insert into public.triagem_uso (dia, modelo, op, input_tokens, output_tokens, chamadas)
  values (p_dia, p_modelo, p_op, p_in, p_out, 1)
  on conflict (dia, modelo, op) do update set
    input_tokens = public.triagem_uso.input_tokens + excluded.input_tokens,
    output_tokens = public.triagem_uso.output_tokens + excluded.output_tokens,
    chamadas = public.triagem_uso.chamadas + 1;
$$;

-- "Não é chamado" soma uma dispensa; "virou chamado" zera (o limiar da pessoa
-- sobe com 5 seguidas, ver LIMIAR_QUEM_DISPENSA). Somar pela API seria ler e
-- gravar, e duas dispensas juntas virariam uma.
create or replace function public.triagem_dispensa(p_conta text, p_zerar boolean)
returns void
language sql
set search_path = ''
as $$
  insert into public.triagem_conta (conta, dispensas)
  values (p_conta, case when p_zerar then 0 else 1 end)
  on conflict (conta) do update set
    dispensas = case when p_zerar then 0 else public.triagem_conta.dispensas + 1 end;
$$;

-- Função nova no Postgres pode ser chamada por qualquer papel: só o backend.
revoke execute on function public.triagem_somar_uso(date, text, text, bigint, bigint) from public, anon, authenticated;
revoke execute on function public.triagem_dispensa(text, boolean) from public, anon, authenticated;
grant execute on function public.triagem_somar_uso(date, text, text, bigint, bigint) to service_role;
grant execute on function public.triagem_dispensa(text, boolean) to service_role;

grant select, insert, update, delete on
  public.triagem_piloto,
  public.triagem_conta,
  public.triagem_sugestao,
  public.triagem_feito,
  public.triagem_encerrada,
  public.triagem_registro,
  public.triagem_uso
to service_role;
-- O id dos registros vem desta sequência.
grant usage, select on sequence public.triagem_registro_id_seq to service_role;
