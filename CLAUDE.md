# Instruções do projeto (humano ou IA)

**Backend do Assistente de Reuniões.** API HTTP que recebe o áudio, transcreve
com **Whisper** e resume com **Gemini**. É o par do aplicativo desktop
(`conversor_WAV_txt`).

Há um `DOCS.md` neste repositório — leia-o antes de mexer.

---

# Regras

## 1. Nada falha em silêncio

Transcrição ou resumo que falhou **precisa chegar ao cliente como erro**, não
como resposta vazia. Um resumo em branco é indistinguível de "a reunião não
tinha nada", e quem recebe não tem como saber a diferença.

`catch` que engole erro tem que logar o que aconteceu, e o cliente precisa
receber um motivo, não um 200 mudo.

## 2. Chamada a modelo custa dinheiro e tempo

Whisper e Gemini não são chamadas grátis nem rápidas.

- **retentativa sem critério é despesa.** Erro definitivo (áudio inválido,
  chave recusada) não melhora com repetição;
- **toda chamada externa leva timeout**;
- áudio grande é o caso normal, não a exceção — pense no upload e no tempo de
  processamento antes de assumir que a requisição termina rápido.

## 3. Commit: `tipo(escopo): descrição`

`feat`, `fix`, `chore`, `docs`, `test`, `refactor`. Escopo é o módulo.

- **Sem co-autoria de IA.** Nem `Co-Authored-By`, nem "gerado com", nem menção
  a ferramenta no corpo.
- **UM arquivo por commit.** Mudou três arquivos? São três commits. Se um
  arquivo sozinho não fecha a mudança, diga e pergunte — não agrupe calado.
- **Mensagem curta.** Assunto e, quando fizer falta, uma ou duas linhas de
  porquê. A explicação longa mora no comentário do código.
- **`push` só quando o usuário autorizar.** Commit é local e reversível;
  publicar não é. Autorização de um push **não vale** para o próximo.

## 4. Antes de agir por conta própria, pergunte — e com opções

Se a solução que você vê é diferente da que o usuário descreveu, pare antes de
implementar. A pergunta vem com as opções que você mapeou, cada uma dizendo o
que acontece se for escolhida. **Trocar de modelo ou de provedor é decisão
dele.**

## 5. Faça o que foi pedido — nem menos, nem mais

Sem função extra, sem refatoração de carona. Achou algo quebrado fora do
escopo? Diga em uma frase e siga.

## 6. Não recrie o que já existe

`src/` já separa `controllers`, `routes`, `services`, `middlewares`, `lib` e
`utils`. **Procure antes de escrever** — por nome e por comportamento (`grep`).

## 7. Áudio de reunião é conteúdo sensível

Gravação e transcrição podem conter assunto interno. Não jogue conteúdo
transcrito em log, e cuide de `uploads/` — arquivo temporário que fica para
sempre vira acervo que ninguém sabe que existe.

## 8. Comentário explica o PORQUÊ

O código já diz o que faz. O comentário existe para o próximo não refazer uma
investigação. Em português, como o resto.

---

# Arquitetura

```
src/
├─ index.ts , server.ts , app.ts
├─ routes/ , controllers/
├─ services/       whisper, gemini
├─ middlewares/
├─ lib/ , utils/ , config/
└─ types/
uploads/           áudio recebido
```

- **Stack:** Node + TypeScript + Express.
- **Dependências de peso:** `nodejs-whisper` (precisa de ffmpeg e toolchain
  C++), `@google/genai`, `ably` (tempo real), `@upstash/redis`,
  `@vercel/functions`.
- **Scripts:** `npm run dev`, `build`, `start`.
- **Configuração:** `GEMINI_API_KEY` e o resto no `.env`.

## O ambiente é parte do código aqui

`nodejs-whisper` depende de **ffmpeg no PATH** e de toolchain C++. "Funciona na
minha máquina" tem causa concreta neste projeto: máquina sem ffmpeg falha na
transcrição, não no código. Ao investigar falha de transcrição, confira o
ambiente antes de ler o código.

---

# O que ainda não está documentado

Armadilhas e decisões deste projeto ainda não foram registradas aqui. Ao
descobrir por que algo quebrou, **escreva neste arquivo**.
