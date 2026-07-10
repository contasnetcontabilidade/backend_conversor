# Documentação — Backend (`backend_conversor`)

Backend em **Node.js + TypeScript + Express 5**, publicado na **Vercel** (serverless). Ele é o cérebro do sistema: recebe eventos de ligações do **GoTo Connect**, baixa a gravação, **transcreve e resume com o Gemini**, avisa o desktop em **tempo real (Ably)** e cria **chamados no Suite360/SuiteWeb** — sempre com um passo de revisão antes de criar de verdade.

> Este é o documento mais importante do projeto. O app desktop (`conversor_WAV_txt`) é só a "cara" — quase toda a lógica vive aqui.

---

## Índice

1. [Visão geral e fluxos](#1-visão-geral-e-fluxos)
2. [Como rodar (local e Vercel)](#2-como-rodar-local-e-vercel)
3. [Arquitetura e organização do código](#3-arquitetura-e-organização-do-código)
4. [Endpoints (API)](#4-endpoints-api)
5. [Integrações externas](#5-integrações-externas)
6. [Regras de negócio importantes](#6-regras-de-negócio-importantes)
7. [Custos (Gemini e infraestrutura)](#7-custos-gemini-e-infraestrutura)
8. [Variáveis de ambiente (explicação de cada chave)](#8-variáveis-de-ambiente-explicação-de-cada-chave)
9. [Segurança — pontos de atenção](#9-segurança--pontos-de-atenção)
10. [Erros e como são tratados](#10-erros-e-como-são-tratados)

---

## 1. Visão geral e fluxos

O sistema existe para **transformar ligações telefônicas em chamados** automaticamente, sem digitação manual, mas **com conferência humana obrigatória**.

### Fluxo principal — ligação vira chamado

```
GoTo (ligação encerra)
   │  webhook POST /goto/webhook/<token>
   ▼
Backend responde 200 na hora e processa em segundo plano
   │  descobre quem participou (ramais) e o número externo
   ▼
Publica "call-ended" no Ably, no canal do ramal (ramal:<ramal>)
   │
   ▼
Desktop recebe em tempo real → mostra popup "Chamada encerrada"
   │  usuário clica "Abrir chamado"
   ▼
POST /goto/chamado/preview
   │  baixa gravação → transcreve (Gemini) → resume (Gemini)
   │  resolve cliente (telefone), assunto, setor, executor, origem
   ▼
Desktop mostra o MODAL DE REVISÃO (tudo editável)
   │  usuário confere/ajusta e confirma
   ▼
POST /goto/chamado/criar
   │  idempotência (não duplica) + dry-run gate
   ▼
Chamado criado no Suite360 → devolve o protocolo
```

### Fluxo secundário — transcrever/resumir arquivo manual

O desktop também tem uma aba "Transcrever & Resumir" para arquivos avulsos (`.wav`/`.srt`), que usa `POST /processar-upload`, `POST /transcricao`, `POST /resumo` e `POST /processar`. Não cria chamado.

### Fluxo de administração — custos de IA

`GET /admin` serve um painel (HTML autossuficiente com gráficos) que consulta `GET /admin/uso` para mostrar quanto foi gasto em tokens do Gemini, convertido para BRL.

---

## 2. Como rodar (local e Vercel)

### Local (desenvolvimento)

```bash
npm install
cp .env.example .env      # e preencha as chaves
npm run dev               # tsx src/index.ts (hot start)
```

O servidor sobe em `http://localhost:3000` (ou `PORT`). Teste rápido:

```bash
curl http://localhost:3000/health
# { "ok": true, "status": "up", "timestamp": "..." }
```

Scripts (`package.json`):

| Script            | Faz                                              |
| ----------------- | ------------------------------------------------ |
| `npm run dev`   | Roda direto o TypeScript com`tsx` (sem build). |
| `npm run build` | Compila com`tsc` para `dist/`.               |
| `npm start`     | Roda`node dist/index.js` (usa o build).        |

### Vercel (produção)

- **Não há `vercel.json`.** A Vercel usa o **export default** do Express em `src/app.ts` como handler serverless.
- As variáveis de ambiente são configuradas em **Project Settings → Environment Variables** (nunca no `.env`, que é local).
- O `PORT` é ignorado na Vercel (o runtime cuida disso).
- **Atenção serverless:** cada invocação pode ser um processo novo. Por isso o **storage (Upstash/KV) é obrigatório** em produção — sem ele, tokens do GoTo, fila de eventos e idempotência ficam só em memória e se perdem entre invocações. Além disso, o **Whisper local não funciona na Vercel** (precisa de ffmpeg/cmake); quando `VERCEL` está setado, o código troca a transcrição para o **Gemini** automaticamente.

---

## 3. Arquitetura e organização do código

Express com a divisão clássica **rotas → controllers → services**. Regra de ouro: **controllers orquestram, services falam com o mundo externo** (Gemini, GoTo, Ably, Redis, Suite360).

### Wiring da aplicação (`src/app.ts`)

Ordem dos middlewares:

1. `disable("x-powered-by")`
2. **CORS** (manual): `Access-Control-Allow-Origin: *`, métodos `GET,POST,PUT,PATCH,DELETE,OPTIONS`, headers incluindo `Content-Type, Authorization, x-app-token`; responde `OPTIONS` com `204`.
3. `express.json({ limit: "5mb" })`
4. `requestLogger` (loga `MÉTODO URL status tempo`)
5. **Router montado DUAS vezes:** em `/` **e** em `/api`. Ou seja, toda rota existe como `/health` **e** `/api/health`. O desktop chama sempre com o prefixo **`/api`**.
6. `notFoundHandler` → `errorHandler` (sempre por último).

`src/index.ts` é o entrypoint local (carrega `dotenv`, lê `PORT`, sobe o servidor). `src/server.ts` tem o `startHttpServer()` (valida a porta, faz `listen`, com fallback de porta se `EADDRINUSE`).

### Mapa de pastas

```
src/
├── index.ts                 Entrypoint local (dotenv, PORT, sobe servidor)
├── server.ts                startHttpServer() — listen + fallback de porta
├── app.ts                   Express app + export default (handler da Vercel)
│
├── routes/
│   └── api.routes.ts        Único router; aplica appAuth e registra tudo
│
├── controllers/
│   ├── api.controller.ts        Transcrição/resumo genéricos + health
│   ├── goto.controller.ts       OAuth, webhook, setup, ably-token, eventos,
│   │                            histórico, chamado; e analisarChamada (reusada)
│   ├── suite360.controller.ts   preview/criar chamado + proxies de dropdown
│   └── admin.controller.ts      Painel de custos (/admin e /admin/uso)
│
├── services/
│   ├── gemini.ts            Resumo estruturado (JSON) + retry + normalização de erro
│   ├── geminiThinking.ts    Config de "thinking" por família de modelo (custo)
│   ├── transcricao.ts       Transcrição: Whisper local OU Gemini; ffmpeg; retries
│   ├── gotoAuth.ts          OAuth 2.0 do GoTo (authorize, troca de code, refresh)
│   ├── gotoApi.ts           REST do GoTo (accountKey, webhook, report, gravação)
│   ├── ably.ts              Publica call-ended; emite token temporário por ramal
│   ├── store.ts             Redis/KV (Upstash) + fallback memória; idempotência
│   ├── suite360.ts          Cliente da API Suite + TODOS os resolvers + criarChamado
│   ├── usage.ts             Contadores de uso de tokens (por dia/modelo/operação)
│   └── pricing.ts           Tabela de preço do Gemini (USD) + cotação USD→BRL
│
├── middlewares/
│   ├── appAuth.ts           Auth por token compartilhado (x-app-token)
│   ├── errorHandler.ts      Handler global de erros → JSON padronizado
│   ├── notFound.ts          404 ROUTE_NOT_FOUND
│   ├── requestLogger.ts     Log de requisições
│   └── upload.ts            Multer (upload de áudio, 300 MB, campo audioFile)
│
├── lib/errors.ts            Classe AppError + helpers
├── utils/
│   ├── http.ts              asyncHandler (captura erros de rotas async)
│   ├── paths.ts             Raiz do projeto (sobe até achar package.json)
│   └── request.ts           Validadores de body (ensureBodyObject, etc.)
└── types/                   Tipos auxiliares (multer, nodejs-whisper)
```

---

## 4. Endpoints (API)

> Toda rota funciona em `/<rota>` **e** em `/api/<rota>`. O desktop usa `/api`. As rotas de webhook/oauth/setup/admin/health são **isentas** da autenticação `x-app-token`.

### 4.1 Núcleo — transcrição e resumo (`api.controller.ts`)

| Método  | Rota                  | O que faz                                                                                |
| -------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `GET`  | `/health`           | Liveness:`{ ok, status: "up", timestamp }`.                                            |
| `POST` | `/transcricao`      | Transcreve um áudio (por`audioPath`) → `{ audioPath, srtPath, transcript }`.       |
| `POST` | `/resumo`           | Resume a partir de`srtPath`/`audioPath` → JSON de resumo.                           |
| `POST` | `/processar`        | Transcreve**e depois** resume, numa chamada só.                                   |
| `POST` | `/processar-upload` | Upload multipart (campo`audioFile`); flags `executarTranscricao`/`executarResumo`. |
| `POST` | `/processar_upload` | Alias com underscore da rota acima.                                                      |

### 4.2 GoTo (`goto.controller.ts`)

| Método  | Rota                     | O que faz                                                                                                  |
| -------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `GET`  | `/goto/oauth/start`    | Redireciona o super-admin para o consentimento do GoTo.*(isento de auth)*                                |
| `GET`  | `/goto/oauth/callback` | Troca o`code` por tokens, cria canal + assinatura do webhook, mostra página HTML. *(isento)*          |
| `POST` | `/goto/setup/:token`   | Recria canal + assinatura após deploy; protegido pelo`GOTO_WEBHOOK_TOKEN` na URL. *(isento)*          |
| `POST` | `/goto/webhook/:token` | Recebe eventos de ligação do GoTo; responde**200 na hora** e roteia em segundo plano. *(isento)* |
| `GET`  | `/goto/eventos`        | Polling do desktop: drena os eventos "call-ended" pendentes da fila.                                       |
| `GET`  | `/goto/historico`      | `?ramal&limit` — últimas ligações de um ramal (API de call-history).                                 |
| `GET`  | `/goto/ably-token`     | `?ramal` — devolve um TokenRequest do Ably escopado só naquele ramal.                                  |
| `POST` | `/goto/chamado`        | Baixa a gravação, transcreve e resume para um`conversationSpaceId`.                                    |

### 4.3 Suite360 (`suite360.controller.ts`)

| Método  | Rota                      | O que faz                                                                     |
| -------- | ------------------------- | ----------------------------------------------------------------------------- |
| `POST` | `/goto/chamado/preview` | Monta o**rascunho completo** do chamado para revisão (não cria nada). |
| `POST` | `/goto/chamado/criar`   | Cria o chamado (com dry-run gate + idempotência).                            |
| `GET`  | `/suite360/clientes`    | `?q` ou `?cnpj` — busca manual de cliente (proxy).                       |
| `GET`  | `/suite360/tipos`       | `?q` — dropdown de tipos de chamado (Assunto).                             |
| `GET`  | `/suite360/setores`     | Dropdown de setores.                                                          |
| `GET`  | `/suite360/origens`     | Dropdown de origens do chamado.                                               |
| `GET`  | `/suite360/usuarios`    | `?q` — dropdown de usuários (executor).                                   |

> Os endpoints `/suite360/*` são **proxies**: o desktop nunca vê a chave do Suite; ele pede pro backend, que consulta o Suite com a `SUITE360_API_KEY` e devolve só a lista.

### 4.4 Admin (`admin.controller.ts`)

| Método | Rota           | O que faz                                                                                           |
| ------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `GET` | `/admin`     | Painel HTML autossuficiente de custos de IA (login próprio, gráficos).*(isento de auth de app)* |
| `GET` | `/admin/uso` | Relatório JSON de uso/custo; exige`Authorization: Bearer <ADMIN_PASSWORD>`. *(isento)*         |

### Formato de resposta

- **Sucesso:** varia por rota (ver tabela). Geralmente `{ ok: true, ... }`.
- **Erro:** sempre `{ ok: false, error: { code, message, details? } }` (ver seção 9).

---

## 5. Integrações externas

### GoTo Connect

- **OAuth 2.0** (`gotoAuth.ts`): fluxo Authorization Code contra `GOTO_AUTH_BASE`. `GOTO_CLIENT_ID`/`GOTO_CLIENT_SECRET` no Basic auth, `GOTO_REDIRECT_URI` tem que bater exatamente. O **refresh token** é persistido no storage (ou semeado por `GOTO_REFRESH_TOKEN`). O access token fica em cache (memória → storage → refresh).
- **REST** (`gotoApi.ts`, base `GOTO_API_BASE`):
  - **accountKey**: de `GOTO_ACCOUNT_KEY`, senão do cache, senão via `GET /me`.
  - **Webhook**: cria o canal `POST /notification-channel/v1/channels/<GOTO_CHANNEL_NICKNAME>` apontando para `<GOTO_PUBLIC_BASE>/api/goto/webhook/<GOTO_WEBHOOK_TOKEN>`, e assina os eventos `STARTING`/`ENDING`.
  - **Relatório da ligação**: `GET /call-events-report/v1/reports/<conversationSpaceId>` (404 = ainda não pronto → o backend faz retry).
  - **Gravação**: 2 passos — pega o `token` da gravação (precisa estar `UPLOADED`) e depois baixa o conteúdo (MP3/WAV) pro tmp.
- O webhook é **fire-and-ack**: responde 200 imediatamente e roteia o evento em segundo plano (`waitUntil` da Vercel).

### Ably (tempo real)

- A **root key `ABLY_API_KEY` fica só no backend**. Ele publica o evento `call-ended` no canal `ramal:<ramal>`.
- O desktop **nunca** recebe a root key: ele pede um **token temporário escopado** em `GET /goto/ably-token?ramal=<ramal>` (capability só de `subscribe` no próprio canal). Se `ABLY_API_KEY` estiver vazia, o push em tempo real é desligado.

### Upstash Redis / Vercel KV (storage)

- `store.ts` e `usage.ts` aceitam **os nomes do Upstash** (`UPSTASH_REDIS_REST_URL/TOKEN`) **ou** os da integração KV da Vercel (`KV_REST_API_URL/TOKEN`).
- Guarda: tokens/canal/accountKey do GoTo, fila de eventos, flags "chamado aberto", **registros e locks de idempotência** e contadores de uso de tokens.
- Sem storage → **fallback em memória volátil** (não persiste entre invocações serverless). Ok para dev local; **inaceitável em produção**.

### Gemini (`@google/genai`)

- Chave `GEMINI_API_KEY` (ou `GOOGLE_API_KEY`). Usado para **transcrição** (upload do áudio + `generateContent`) e **resumo** (`generateContent` com schema JSON forçado).
- Custo do "thinking" é minimizado via `geminiThinking.ts`. O uso de tokens é gravado no Redis e precificado em `pricing.ts` (tabela USD + cotação USD→BRL com cache de 6h; fallback `GEMINI_USD_BRL`).

### Suite360 / SuiteWeb

- Base `SUITE360_BASE_URL`, Bearer `SUITE360_API_KEY` (ou `SUITEWEB_API_KEY`). Envelope `{ success, data }`.
- Endpoints usados: `/whatsapp/contatos`, `/clientes`, `/tipos-chamado`, `/setores`, `/origens-chamado`, `/usuarios`, `POST /chamados`.
- **DEV vs PROD:** têm URLs, chaves **e IDs** diferentes. O DEV (`http://10.10.1.183/...`) só é alcançável na rede interna — a **Vercel não alcança** esse IP. Por isso os resolvers trabalham **por nome** (robusto entre DEV e PROD).

---

## 6. Regras de negócio importantes

### Dry-run (simular vs criar de verdade)

`SUITE360_DRY_RUN` controla o `POST /chamados`:

- **`1` (padrão)** → **simula**: `criarChamado` devolve `{ dryRun: true, body }` (o JSON que *seria* enviado). Nada é criado. No modal aparece "Prévia do envio".
- **`0` / `false` / `no` / `off`** → **cria de verdade**.

### Idempotência (não duplica chamado)

No `POST /goto/chamado/criar`, em produção:

1. `getChamadoCriado(conv)` — se já existe chamado para essa ligação, devolve o **protocolo existente** (não cria de novo).
2. Senão, `reservarCriacao(conv)` — lock atômico `SET NX EX 120`. Se outra pessoa já está criando o mesmo, retorna **409 `CHAMADO_EM_CRIACAO`**.
3. Cria o chamado; em erro, libera o lock. Em sucesso, salva `{ id, protocolo }` (TTL 30 dias) e libera o lock.

Isso resolve o caso da **ligação interna**: se uma pessoa abriu o chamado, a outra não consegue abrir um duplicado para a mesma ligação. (O Suite ainda tem um debounce próprio que rejeita corpos idênticos em <500ms.)

### Resolução automática dos campos do chamado (os "resolvers")

Ao montar o preview, o backend tenta preencher tudo sozinho (o usuário confirma no modal):

- **Cliente**:
  - **Ligação interna** → **cliente padrão do escritório** (CONTAS Serviços Contábeis S/S), via `resolverClienteInterno`. Para funcionar em DEV e PROD (onde os IDs diferem), ele resolve **pelo CNPJ** `04.248.189/0001-97`, com o id `1717` (dev) só como último recurso; dá para fixar por `SUITE360_CLIENTE_INTERNO_ID`.
  - **Ligação externa** → por telefone (`resolverClientePorTelefone`): varia o número (com/sem DDI 55, últimos 8/9 dígitos) e busca em `/whatsapp/contatos`; só resolve sozinho com **exatamente um** cliente e confiança **alta**. Se o telefone **não** resolver, tenta pelo **nome/CNPJ que a IA captou na conversa** (`resolverClientePorMencao`) — e só aceita se houver **um único** match forte (nunca chuta o cliente errado).
- **Assunto** (tipo de apontamento) — a **IA escolhe da lista real de assuntos do Suite**: o backend busca os tipos ativos (`buscarTipos()`) e os envia no prompt; a IA, **com base no que foi dito**, devolve o `assunto_escolhido` (id + nome) copiado da lista. O backend valida que o id existe na lista (`fonte: "ia"`). Se a IA não escolher nada (ou a lista falhar), cai no antigo match textual `resolverAssuntoPorTexto` (sobreposição de palavras); nunca "chuta".
- **Setor** — **pelo nome do usuário do GoTo** (`resolverSetorPorNomeUsuario`). O nome vem como `"NOME - SETOR"`. Em ligação **interna** usa quem ligou; em **externa** usa o atendente do escritório. O departamento vira setor do Suite via um **mapa de aliases** (`aliasesSetor()`): **tudo que é tecnologia** (desenvolvimento/TI/infra/hardware...) → **Suporte**; `ed. financeira` → `Educação Financeira`; `legalização` → `Regularização Fiscal`. Dá pra estender por `SUITE360_SETOR_ALIASES`.
- **Executor** — `resolverExecutorPorNome`: tira o `" - SETOR"` do nome e busca em `/usuarios?ativo=1&q=`.
- **Origem** — `resolverOrigem`: prefere "Telefone"/"Ligação".
- **Data/hora e duração** — de `callCreated`/`callEnded` do relatório (não de `startTime`/`duration`, que não existem nesse relatório).

Os IDs fixos (`SUITE360_*_ID`) têm **prioridade**: se preenchidos, fixam o valor e pulam o lookup.

### Seleção do provider de transcrição

`TRANSCRICAO_PROVIDER` força `whisper` ou `gemini`. Se vazio: **Gemini quando na Vercel** (`VERCEL` setado), **Whisper localmente**.

---

## 7. Custos (Gemini e infraestrutura)

O único custo que **varia com o uso** é a **API do Gemini** (transcrição + resumo). As demais peças (Vercel, Upstash, Ably) ficam, para este volume, na faixa gratuita; GoTo e Suite são produtos que a empresa já paga por outros motivos.

### 7.1 Tabela de preços do Gemini

Valores em **USD por 1 milhão de tokens**, exatamente como estão no código (`src/services/pricing.ts`). Modelo fora da tabela usa o preço do `gemini-2.5-flash`.

| Modelo                             | Entrada (input)         | Saída (output) |
| ---------------------------------- | ----------------------- | --------------- |
| `gemini-2.5-flash` *(padrão)* | US$ 0,30 | US$ 2,50   |                 |
| `gemini-2.5-flash-lite`          | US$ 0,10 | US$ 0,40   |                 |
| `gemini-2.0-flash`               | US$ 0,10 | US$ 0,40   |                 |
| `gemini-1.5-flash`               | US$ 0,075 | US$ 0,30  |                 |
| `gemini-1.5-flash-8b`            | US$ 0,0375 | US$ 0,15 |                 |
| `gemini-1.5-pro`                 | US$ 1,25 | US$ 5,00   |                 |
| `gemini-1.0-pro`                 | US$ 0,50 | US$ 1,50   |                 |

> ⚠️ **Estes são valores de referência embutidos no código** — confirme os preços atuais em https://ai.google.dev/gemini-api/docs/pricing e ajuste a tabela em `pricing.ts` se mudarem. A conversão para BRL usa a cotação USD→BRL ao vivo (cache de 6h; fallback `GEMINI_USD_BRL`, padrão R$ 5,40).
>
> A fórmula usada (`custoUsd`): `custo = (tokens_entrada/1M × preço_entrada) + (tokens_saída/1M × preço_saída)`.

### 7.2 Estimativa por ligação (ordem de grandeza)

Uma ligação gera **duas** chamadas ao Gemini: transcrever o áudio e resumir a transcrição. O áudio é tokenizado a **~32 tokens por segundo** (referência do Gemini). Exemplo para uma **ligação de ~5 minutos** com o modelo padrão `gemini-2.5-flash`:

| Etapa                                                  | Tokens entrada | Tokens saída | Custo aprox.                      |
| ------------------------------------------------------ | -------------- | ------------- | --------------------------------- |
| Transcrição (áudio 5 min ≈ 9.600 tok + saída SRT) | ~9.600         | ~1.500        | ~US$ 0,0066                       |
| Resumo (transcrição + prompt → JSON)                | ~2.500         | ~600          | ~US$ 0,0023                       |
| **Total por ligação**                          |                |               | **~US$ 0,009 ≈ R$ 0,05** |

Ou seja, **na casa de centavos de real por ligação** de poucos minutos. Projeção grosseira: **1.000 ligações/mês ≈ US$ 9 ≈ R$ 50/mês** só de Gemini. Ligações mais longas custam proporcionalmente mais (o áudio domina o custo de entrada da transcrição).

> Estes números são **estimativas** — o custo real depende da duração de cada ligação, do tamanho da transcrição e do modelo escolhido. O **valor de verdade** você vê no painel `/admin`, que soma os tokens realmente gastos (gravados no Redis por `usage.ts`) e converte para BRL.

### 7.3 Como reduzir custo

- Use `gemini-2.5-flash-lite` (ou `2.0-flash`) para transcrição/resumo quando aceitável — **~3× a 6× mais barato** que o `2.5-flash` na saída.
- Mantenha `GEMINI_THINKING_BUDGET=0` (já é o padrão) para desligar o "thinking" nos modelos 2.x/1.5 — a 1ª tentativa do resumo já roda com thinking desligado.
- O guard de transcrição vazia evita chamar o modelo quando não há áudio útil.

### 7.4 Custos de infraestrutura (faixa gratuita → escalação)

Hoje, no volume atual, quase tudo cabe na **faixa gratuita**. A tabela abaixo mostra o **próximo degrau pago** de cada serviço — quanto custaria e **o que dispara** a cobrança — para você projetar a escalação.

| Serviço                            | Papel                                                          | Faixa gratuita (hoje)                                                       | Próximo degrau pago                                                                                     | O que dispara a cobrança                                                                                              |
| ----------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Vercel**                    | Hospeda o backend serverless                                   | Plano**Hobby** (grátis)                                              | **Pro ≈ US$ 20/mês por membro** (~R$ 108)                                                            | Uso comercial, mais execuções/banda, limites de função maiores.                                                    |
| **Upstash Redis / Vercel KV** | Tokens GoTo, fila de eventos, idempotência, contadores de uso | ~500 mil comandos/mês, 256 MB (grátis)                                    | **Pay-as-you-go: ~US$ 0,20 por 100 mil comandos**; plano fixo ~**US$ 10/mês** (limites maiores) | Nº de comandos Redis/mês e armazenamento. Cada ligação faz poucos comandos → escala devagar.                      |
| **Ably**                      | Push em tempo real por ramal                                   | ~6 milhões de mensagens/mês, ~200 conexões/canais simultâneos (grátis) | **Standard ≈ US$ 30/mês** base + uso (~R$ 160)                                                       | Nº de mensagens/mês e de conexões simultâneas (1 por ramal ativo).                                                 |
| **GoTo Connect**              | Telefonia + eventos de ligação                               | — (produto já pago)                                                       | — (produto já pago)                                                                                    | Nº de ramais/licenças. A**integração** não cobra à parte; o custo é o da telefonia que a empresa já tem. |
| **Suite360 / SuiteWeb**       | Sistema de chamados                                            | — (interno)                                                                | Sem custo por chamado via API                                                                            | Interno da empresa; criar chamado pela API não adiciona custo.                                                        |

> ⚠️ **Valores de referência (mudam com frequência).** Confirme no pricing oficial de cada serviço: [Vercel](https://vercel.com/pricing), [Upstash](https://upstash.com/pricing), [Ably](https://ably.com/pricing), [GoTo](https://www.goto.com/connect/pricing). O câmbio usado nas conversões em R$ foi ~R$ 5,40/US$.

**Cenário de escalação (estimativa somando tudo, por mês):**

| Volume                  | Gemini                 | Infra (Vercel+Upstash+Ably)                                                                    | Total aprox. (fora GoTo/telefonia) |
| ----------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| ~1.000 ligações/mês  | ~US$ 9 (~R$ 50)      | **US$ 0** (tudo grátis) | **~R$ 50/mês**                                             |                                    |
| ~10.000 ligações/mês | ~US$ 90 (~R$ 490)    | provavelmente ainda grátis, ou ~US$ 10–20 se estourar Upstash/Ably | **~R$ 500–600/mês** |                                    |
| ~50.000 ligações/mês | ~US$ 450 (~R$ 2.430) | ~US$ 20 (Vercel Pro) + ~US$ 10–30 (Upstash) + ~US$ 30 (Ably) | **~R$ 2.700–2.900/mês**  |                                    |

> O **Gemini domina o custo variável** — a infraestrutura só vira despesa relevante em volume alto. GoTo (telefonia) fica de fora por ser custo que a empresa já paga independentemente desta integração.

---

## 8. Variáveis de ambiente (explicação de cada chave)

> O código **não** tem um módulo central de config — cada service lê `process.env` direto. A tabela abaixo cobre **todas** as chaves que o código realmente lê. Um `.env.example` pronto para copiar está na raiz do projeto.
>
> Legenda: **🔒 = segredo** (nunca commitar/expor) · **Obrig.** = quebra sem ela · **Opc.** = tem default no código.

### IA / Gemini

| Chave                                        | Para que serve                                                                    | Obrig./Opc. (default)                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY` 🔒                        | Chave da API Gemini (transcrição + resumo).                                     | **Obrig.** — sem ela, toda chamada ao Gemini falha com `GEMINI_API_KEY_MISSING`. |
| `GOOGLE_API_KEY` 🔒                        | Alias de fallback: usado se`GEMINI_API_KEY` estiver vazia.                      | Opc.                                                                                      |
| `GEMINI_MODEL`                             | Modelo do Gemini para o**resumo**.                                          | Opc. (`gemini-2.5-flash`)                                                               |
| `GEMINI_TRANSCRIPTION_MODEL`               | Modelo do Gemini para a**transcrição**.                                   | Opc. (`gemini-2.5-flash`)                                                               |
| `GEMINI_TRANSCRIPTION_FALLBACK_MODELS`     | Modelos de fallback (separados por vírgula) se o principal ficar indisponível.  | Opc. (`gemini-2.5-flash-lite`)                                                          |
| `GEMINI_TRANSCRIPTION_RETRY_ATTEMPTS`      | Nº de retries em erro transitório na transcrição.                             | Opc. (`4`)                                                                              |
| `GEMINI_TRANSCRIPTION_RETRY_BASE_DELAY_MS` | Delay base do backoff entre retries.                                              | Opc. (`800`)                                                                            |
| `GEMINI_THINKING_LEVEL`                    | Nível de "thinking" para modelos Gemini 3 (não dá pra desligar; mín.`low`). | Opc. (`low`)                                                                            |
| `GEMINI_THINKING_BUDGET`                   | Budget de thinking para modelos 2.x/1.5 —**`0` desliga** (economia).     | Opc. (`0`)                                                                              |
| `GEMINI_USD_BRL`                           | Câmbio USD→BRL de fallback no painel de custos.                                 | Opc. (`5.4`)                                                                            |

### Transcrição / Whisper

| Chave                    | Para que serve                                                            | Obrig./Opc. (default)        |
| ------------------------ | ------------------------------------------------------------------------- | ---------------------------- |
| `TRANSCRICAO_PROVIDER` | Força`whisper` ou `gemini`. Vazio = Gemini na Vercel, Whisper local. | Opc. (vazio → auto)         |
| `WHISPER_MODEL`        | Modelo do Whisper local (`nodejs-whisper`).                             | Opc. (`base`)              |
| `DEFAULT_AUDIO_FILE`   | Nome de arquivo de áudio padrão quando nenhum é informado.             | Opc. (`audio_reuniao.WAV`) |
| `UPLOAD_DIR`           | Pasta de uploads (absoluta ou relativa à raiz). Fallback: tmp do SO.     | Opc. (`uploads`)           |

### Servidor

| Chave    | Para que serve                         | Obrig./Opc. (default) |
| -------- | -------------------------------------- | --------------------- |
| `PORT` | Porta HTTP local (ignorada na Vercel). | Opc. (`3000`)       |

### GoTo Connect

| Chave                     | Para que serve                                                                 | Obrig./Opc. (default)                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `GOTO_CLIENT_ID` 🔒     | Client id do app GoTo (Basic auth + URL de authorize).                         | **Obrig.** para OAuth.                                                                                            |
| `GOTO_CLIENT_SECRET` 🔒 | Client secret do app GoTo.                                                     | **Obrig.** para OAuth.                                                                                            |
| `GOTO_REDIRECT_URI`     | Redirect URI cadastrada no app (deve bater exatamente).                        | **Obrig.** para OAuth.                                                                                            |
| `GOTO_WEBHOOK_TOKEN` 🔒 | Segredo que compõe a URL de`/goto/webhook/:token` e `/goto/setup/:token`. | **Efetivamente obrig.** — se vazio, esses endpoints respondem **404** (desativados) e nenhum evento chega. |
| `GOTO_REFRESH_TOKEN` 🔒 | Semente do refresh token (evita refazer OAuth interativo).                     | Opc. (se não, precisa do fluxo OAuth).                                                                                 |
| `GOTO_ACCOUNT_KEY`      | accountKey do super-admin; se vazio, resolve via`/me` e cacheia.             | Opc.                                                                                                                    |
| `GOTO_CHANNEL_NICKNAME` | Apelido do canal de notificação do webhook.                                  | Opc. (`conversor-call-events`)                                                                                        |
| `GOTO_PUBLIC_BASE`      | Base pública do backend para montar a URL do webhook.                         | Opc. (`https://backend-conversor.vercel.app`)                                                                         |
| `GOTO_AUTH_BASE`        | Base do OAuth do GoTo.                                                         | Opc. (`https://authentication.logmeininc.com`)                                                                        |
| `GOTO_API_BASE`         | Base da REST do GoTo.                                                          | Opc. (`https://api.goto.com`)                                                                                         |
| `GOTO_OAUTH_STATE`      | Valor fixo de`state` no OAuth; se vazio, gera UUID aleatório.               | Opc.                                                                                                                    |

### Ably

| Chave               | Para que serve                                                          | Obrig./Opc. (default)                                                                            |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ABLY_API_KEY` 🔒 | Root key do Ably (só no backend; emite tokens temporários por ramal). | Opc. no geral, mas**obrigatória para o push em tempo real**. Vazia → realtime desligado. |

### Storage (Upstash Redis / Vercel KV)

| Chave                           | Para que serve                                              | Obrig./Opc.                                     |
| ------------------------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`      | URL REST do Redis (token store, dedup, uso, idempotência). | Opc. no código,**obrig. em produção**. |
| `UPSTASH_REDIS_REST_TOKEN` 🔒 | Token REST do Redis.                                        | Idem.                                           |
| `KV_REST_API_URL`             | Alias da integração KV da Vercel (fallback da URL acima). | Opc.                                            |
| `KV_REST_API_TOKEN` 🔒        | Alias da integração KV da Vercel (fallback do token).     | Opc.                                            |

> Se **nenhum** estiver setado, o backend usa memória volátil: **não persiste** entre invocações serverless (quebra persistência, não a inicialização).

### Auth / Admin

| Chave                 | Para que serve                                                                                                             | Obrig./Opc. (default)                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `API_AUTH_TOKEN` 🔒 | Se definido, exige o header`x-app-token` igual a este valor em todas as rotas (exceto webhook/oauth/setup/admin/health). | Opc. (vazio =**auth dormante**, API aberta).                                                                         |
| `ADMIN_PASSWORD` 🔒 | Senha do painel`/admin`.                                                                                                 | Opc. —**⚠️ tem fallback embutido `Contas@2074`**, então o painel nunca fica realmente fechado (ver seção 8). |

### Suite360 / SuiteWeb

| Chave                            | Para que serve                                                                                  | Obrig./Opc. (default)                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `SUITE360_BASE_URL`            | Base da API pública v1 (barras finais são removidas).                                         | Opc. (`https://suiteweb.contasnet.com.br/api/public/v1`)               |
| `SUITE360_API_KEY` 🔒          | Chave da API Suite.                                                                             | **Obrig.** para chamadas reais (senão `SUITE_API_KEY_MISSING`). |
| `SUITEWEB_API_KEY` 🔒          | Alias de fallback da chave acima.                                                               | Opc.                                                                     |
| `SUITE360_DRY_RUN`             | `1` simula o `POST /chamados`; `0/false/no/off` cria de verdade.                          | Opc. (`1` = simula).                                                   |
| `SUITE360_TIPO_APONTAMENTO_ID` | ID fixo do "tipo/assunto"; se vazio, resolve por texto.                                         | Opc.                                                                     |
| `SUITE360_ORIGEM_ID`           | ID fixo de origem; se vazio, resolve por lookup.                                                | Opc.                                                                     |
| `SUITE360_SETOR_ID`            | ID fixo de setor; se vazio, resolve pelo nome do usuário.                                      | Opc.                                                                     |
| `SUITE360_EXECUTOR_ID`         | ID fixo de executor; se vazio, resolve por nome.                                                | Opc.                                                                     |
| `SUITE360_CLIENTE_INTERNO_ID`  | Cliente padrão das ligações **internas** (o próprio escritório). Se vazio, resolve pelo CNPJ da CONTAS (04.248.189/0001-97), com id `1717` como último recurso. | Opc. |
| `SUITE360_SETOR_NOME`          | Nome usado no lookup automático de setor.                                                      | Opc.                                                                     |
| `SUITE360_EXECUTOR_Q`          | Query usada no lookup automático de executor.                                                  | Opc.                                                                     |
| `SUITE360_SETOR_ALIASES`       | Pares extra`departamento=Setor` (separados por `;` ou nova linha) somados ao mapa embutido. | Opc.                                                                     |

### Injetadas pela plataforma (não são config do app)

| Chave                      | Origem             | Efeito                                                                                                                  |
| -------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `VERCEL`                 | Setada pela Vercel | Presença → transcrição usa Gemini (Whisper não roda em serverless).                                                |
| `LOCALAPPDATA`, `PATH` | Windows/SO         | Usadas para localizar o ffmpeg local (o código chega a**acrescentar** a pasta do ffmpeg ao `PATH` em runtime). |

---

## 9. Segurança — pontos de atenção

> Levantados na leitura do código; recomendo tratar antes do go-live definitivo.

- **`ADMIN_PASSWORD` tem fallback embutido `Contas@2074`.** Se a env não for definida, o painel `/admin/uso` aceita essa senha padrão. **Defina uma senha forte em produção.**
- **`API_AUTH_TOKEN` vazio = API totalmente aberta.** A auth por `x-app-token` fica dormante. Só ative **depois** que todas as máquinas já rodam a v1.0.0 do desktop (senão apps antigos tomam 401). O valor tem que ser o **mesmo** no backend (`API_AUTH_TOKEN`) e no build do desktop (`DESKTOP_API_TOKEN`).
- **`GOTO_WEBHOOK_TOKEN` vazio = webhook/setup em 404 silencioso.** O sistema fica "mudo" para eventos do GoTo sem erro aparente. Trate como obrigatório.
- **CORS é `*`.** Aberto para qualquer origem — a proteção real é o `x-app-token`. Faz sentido para o desktop, mas tenha ciência.
- **O `.env` real está presente no disco do projeto** (git-ignored). Trate como segredo local.
- **Rotacionar chaves** antes da produção (Suite prod+dev, Gemini, GoTo, Ably) — várias foram trocadas/expostas durante o desenvolvimento.
- **DEV do Suite (`10.10.1.183`) nunca vai na Vercel** (IP interno inalcançável); é só para teste local.

---

## 10. Erros e como são tratados

O `errorHandler` (global, sempre por último) padroniza toda resposta de erro:

```json
{ "ok": false, "error": { "code": "ALGUM_CODIGO", "message": "texto", "details": { } } }
```

Casos especiais tratados:

- Multer `LIMIT_FILE_SIZE` → **413**; outros erros de multer → **400**.
- JSON malformado (`entity.parse.failed`) → **400 `INVALID_JSON`**.
- Body grande demais (`entity.too.large`) → **413**.
- Rota inexistente → **404 `ROUTE_NOT_FOUND`** (via `notFoundHandler`).
- 5xx são logados no servidor.

Códigos que o **desktop** entende e traduz para o usuário: `CHAMADO_EM_CRIACAO`, `RECORDING_NOT_FOUND`/`RECORDING_NOT_READY`, `REPORT_NOT_READY`, `SUITE_API_KEY_INVALID`/`SUITE_API_KEY_MISSING`, `SUITE_VALIDATION`, `SUITE_RATE_LIMITED`, `SUITE_NOT_FOUND`, `SUITE_UNREACHABLE`, `GEMINI_QUOTA_EXCEEDED`, `APP_UNAUTHORIZED`, além dos fallbacks 401/5xx.

---

*Este documento reflete o código em `src/`. Ao mudar rotas, resolvers ou variáveis de ambiente, atualize as seções 4, 6 e 7 e o `.env.example`.*
