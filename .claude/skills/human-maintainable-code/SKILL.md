# Human-Maintainable Code

Escreva código pensando primeiro na **manutenção humana**.

O código deve ser simples de ler, modificar e depurar por uma pessoa que não escreveu a implementação original.

Prioridades, nesta ordem:

1. Clareza
2. Manutenibilidade
3. Correção
4. Idiomatismo da linguagem
5. Baixa complexidade
6. Brevidade

Não otimize para escrever o menor número possível de linhas.
Otimize para escrever o **menor código que continue sendo óbvio**.

---

## 1. Princípio central

Antes de implementar, pergunte:

> "Se outra pessoa abrir este arquivo daqui a 6 meses, ela vai entender rapidamente o que está acontecendo?"

Se a resposta for não, simplifique.

Prefira:

```ts
const activeUsers = users.filter((user) => user.isActive);
```

a abstrações desnecessárias como:

```ts
const activeUsers = filterCollection(
  users,
  createPredicate((user) => getUserStatus(user) === UserStatus.ACTIVE),
);
```

A menos que exista uma razão concreta para a abstração.

---

## 2. Código curto, mas não comprimido

Evite verbosidade acidental:

- abstrações sem reutilização real
- funções que apenas delegam para outra função
- wrappers desnecessários
- classes usadas apenas como namespaces
- interfaces criadas sem necessidade
- getters/setters triviais
- variáveis intermediárias sem valor semântico
- comentários que repetem o código
- camadas de configuração sem necessidade
- padrões arquiteturais aplicados por hábito

Mas não comprima código a ponto de prejudicar a leitura.

### Prefira

```ts
const user = await getUser(id);

if (!user) {
  return null;
}

return user.email;
```

### Evite

```ts
return (await getUser(id))?.email ?? null;
```

quando a segunda versão tornar o fluxo menos evidente.

Código idiomático é desejável, mas **clareza vem antes de concisão**.

---

## 3. Funções pequenas com responsabilidade clara

Uma função deve responder facilmente:

> "O que esta função faz?"

Prefira funções com uma responsabilidade evidente.

```ts
function calculateTotal(items: CartItem[]) {
  return items.reduce((total, item) => total + item.price, 0);
}
```

Evite funções que:

- validam
- transformam
- persistem
- fazem chamadas HTTP
- registram logs
- alteram estado

tudo ao mesmo tempo, salvo quando isso representar naturalmente uma única operação do domínio.

Não crie funções pequenas apenas para reduzir o tamanho visual de outra função.

---

## 4. Evite abstrações prematuras

Não crie uma abstração apenas porque:

- duas linhas são parecidas
- duas funções possuem estrutura semelhante
- "pode ser reutilizada no futuro"
- existe um padrão arquitetural para isso
- o projeto já possui muitas interfaces/classes

Primeiro escreva a solução simples.

Extraia quando existir uma necessidade concreta:

- reutilização real
- regra de negócio compartilhada
- complexidade isolável
- dependência que precisa ser substituída
- fronteira arquitetural importante

### Regra prática

> Duplicação pequena é frequentemente melhor que uma abstração errada.

---

## 5. Nomes devem carregar intenção

Prefira nomes que expliquem o papel da coisa.

Ruim:

```ts
const data = ...
const result = ...
const temp = ...
const value = ...
```

Melhor:

```ts
const customer = ...
const unpaidInvoices = ...
const normalizedEmail = ...
```

Não use nomes longos apenas para parecer explícito.

Ruim:

```ts
const customerEmailAddressThatWasNormalizedBeforeSending = ...
```

Bom:

```ts
const normalizedEmail = ...
```

O contexto também faz parte do nome.

---

## 6. Comentários são para intenção

Não comente o que o código já diz.

Evite:

```ts
// Incrementa o contador
counter++;
```

Evite:

```ts
// Retorna o usuário
return user;
```

Use comentários para explicar **por quê**, especialmente quando a decisão não for óbvia.

```ts
// Mantemos o cache por 5 minutos porque o serviço externo
// limita a frequência dessas consultas.
const CACHE_TTL = 5 * 60;
```

Ou:

```ts
// O provedor pode reenviar o mesmo evento.
// A operação precisa ser idempotente.
await processEvent(event);
```

Comentários devem registrar conhecimento que seria fácil perder.

---

## 7. Não documente o óbvio

Não transforme cada bloco em uma sequência de comentários.

Ruim:

```ts
// Busca o usuário
const user = await getUser(id);

// Verifica se o usuário existe
if (!user) {
  // Retorna null
  return null;
}

// Retorna o email
return user.email;
```

Bom:

```ts
const user = await getUser(id);

if (!user) {
  return null;
}

return user.email;
```

---

## 8. Controle de fluxo simples

Prefira fluxo linear e fácil de acompanhar.

Use early return quando isso reduzir nesting:

```ts
if (!user) {
  return;
}

if (!user.isActive) {
  return;
}

sendEmail(user);
```

Em vez de:

```ts
if (user) {
  if (user.isActive) {
    sendEmail(user);
  }
}
```

Mas não transforme cada função em uma sequência excessiva de returns se isso fragmentar a lógica.

---

## 9. Evite nesting desnecessário

Código profundamente aninhado é mais difícil de manter.

Prefira:

```ts
if (!request.isValid()) {
  return badRequest();
}

if (!user) {
  return notFound();
}

return updateUser(user);
```

a:

```ts
if (request.isValid()) {
  if (user) {
    return updateUser(user);
  }

  return notFound();
}

return badRequest();
```

---

## 10. Use recursos idiomáticos da linguagem

Escreva como alguém experiente naquela linguagem escreveria.

Exemplos:

- TypeScript → tipos úteis, `map`, `filter`, `reduce`, optional chaining quando melhora a leitura
- Python → comprehensions quando simples, context managers, exceptions idiomáticas
- Go → early returns, erros explícitos, interfaces pequenas
- Rust → `Result`, `Option`, pattern matching e ownership idiomáticos
- Java → APIs padrão, streams quando melhoram a leitura, classes simples quando suficientes
- C# → LINQ e recursos modernos quando tornam o código mais claro

Não use recursos avançados apenas porque existem.

> Idiomático não significa sofisticado.

---

## 11. Tipos devem ajudar, não atrapalhar

Prefira tipos que expressem regras importantes.

Evite tanto:

```ts
any;
```

quanto tipos absurdamente complexos sem necessidade.

Prefira:

```ts
type UserId = string;

type User = {
  id: UserId;
  email: string;
};
```

a construir uma hierarquia de classes apenas para representar dados simples.

Inferência de tipos é desejável quando o tipo é óbvio.

Evite:

```ts
const name: string = user.name;
```

se:

```ts
const name = user.name;
```

já for suficientemente claro.

---

## 12. Não crie constantes para tudo

Constantes são úteis quando:

- o valor tem significado de domínio
- o valor é reutilizado
- o nome melhora a compreensão
- o valor pode mudar por configuração

Evite:

```ts
const ZERO = 0;
const ONE = 1;
const TRUE = true;
```

Prefira:

```ts
const MAX_RETRIES = 3;
const SESSION_TTL = 60 * 60;
```

---

## 13. Evite booleanos ambíguos

Ruim:

```ts
process(user, true, false);
```

Melhor:

```ts
process(user, {
  sendEmail: true,
  notifyAdmin: false,
});
```

Ou, se possível, modele a operação de maneira que os booleanos nem sejam necessários.

---

## 14. Não esconda lógica importante atrás de helpers

Evite:

```ts
if (isEligible(user)) {
  ...
}
```

quando `isEligible()` apenas contém uma condição trivial que seria mais clara no local.

Mas extraia quando a regra possuir significado próprio:

```ts
if (isEligibleForTrial(user)) {
  ...
}
```

O critério é semântico, não o número de linhas.

---

## 15. Evite "framework dentro do framework"

Não construa abstrações próprias para substituir recursos simples já existentes na linguagem, biblioteca ou framework.

Evite criar:

```ts
BaseRepository;
AbstractRepository;
GenericRepository;
RepositoryFactory;
RepositoryProvider;
```

se o projeto precisa apenas de uma consulta simples.

Use a infraestrutura existente antes de inventar uma nova.

---

## 16. Tratamento de erros

Trate erros onde existe contexto suficiente para tomar uma decisão.

Não faça isto:

```ts
try {
  ...
} catch (error) {
  console.log(error);
}
```

apenas para impedir uma exceção.

Não capture erros que você não sabe tratar.

Prefira:

```ts
const user = await getUser(id);
```

e deixe a camada apropriada decidir como lidar com a falha.

Quando capturar:

```ts
try {
  await paymentService.charge(payment);
} catch (error) {
  logger.error('Payment failed', { error, paymentId: payment.id });
  throw new PaymentError('Unable to process payment');
}
```

Preserve contexto útil.

---

## 17. Não espalhe lógica de negócio

Regras de negócio importantes devem ter um lugar claro.

Evite a mesma regra aparecer em:

- controller
- service
- repository
- frontend
- validator

Se uma regra precisa ser conhecida por várias partes do sistema, centralize-a quando isso realmente reduzir inconsistência.

---

## 18. Estruturas de dados simples primeiro

Antes de criar uma classe, considere:

- objeto
- record/map
- array
- enum
- union type
- função

Uma classe deve existir porque seu comportamento ou estado justifica uma classe, não apenas porque "arquitetura limpa" recomenda.

---

## 19. Não over-engineer

Para cada abstração nova, pergunte:

1. Qual problema ela resolve?
2. Esse problema existe agora?
3. Existe uma solução mais simples?
4. Essa abstração facilita ou dificulta a leitura?
5. Um humano novo no projeto entenderá isso rapidamente?

Se não houver uma resposta clara, não crie a abstração.

---

## 20. Compatibilidade com o código existente

Ao alterar código existente:

- preserve padrões já estabelecidos quando forem razoáveis
- não refatore arquivos inteiros sem necessidade
- não misture mudança funcional com refatoração estética grande
- mantenha APIs existentes quando possível
- altere apenas o necessário para resolver o problema

Evite transformar:

> "corrigir uma função"

em:

> "reescrever o módulo inteiro".

---

## 21. Refatoração incremental

Quando encontrar código ruim, não reescreva tudo automaticamente.

Primeiro melhore o ponto necessário.

Exemplo:

```text
1. Entender o comportamento atual
2. Fazer a menor mudança segura
3. Manter testes passando
4. Simplificar somente o que ajuda a mudança atual
5. Evitar refatorações não relacionadas
```

---

## 22. Formatação

Siga o formatter e linter oficiais do projeto.

Não crie preferência pessoal contra o padrão existente.

A consistência do projeto é mais importante que preferência individual.

---

## 23. Código autoexplicativo

O código deve comunicar:

- o que está acontecendo
- quais dados estão envolvidos
- quais decisões estão sendo tomadas
- onde existem efeitos colaterais

Use estrutura e nomes antes de comentários.

Ordem de preferência:

```text
bom nome
↓
boa estrutura
↓
tipo adequado
↓
comentário estratégico
```

Não use comentário para compensar código mal estruturado.

---

## 24. Efeitos colaterais explícitos

Torne operações com efeitos colaterais fáceis de identificar.

Por exemplo:

```ts
const user = await getUser(id);

await saveUser(user);

await sendWelcomeEmail(user);
```

é geralmente mais fácil de entender do que esconder tudo em:

```ts
await onboardUser(id);
```

a menos que `onboardUser()` represente uma operação de domínio real e útil.

---

## 25. Preferência por código local

Quando uma lógica só é usada em um lugar, mantenha-a próxima do lugar onde é usada.

Evite criar:

```text
utils/
helpers/
common/
shared/
misc/
```

para acumular funções sem contexto.

Uma função pertence ao domínio que a utiliza quando isso tornar sua finalidade mais clara.

---

## 26. DRY com moderação

Não elimine toda duplicação.

Duplicação pequena e explícita pode ser melhor do que uma abstração genérica difícil de entender.

Use DRY principalmente para:

- regras de negócio
- invariantes
- comportamento complexo
- lógica que precisa permanecer sincronizada

Não necessariamente para:

- duas chamadas parecidas
- pequenas transformações
- estruturas visualmente semelhantes

---

## 27. Evite código "esperto"

Prefira:

```ts
const activeUsers = users.filter((user) => user.active);
```

a uma solução compacta, mas difícil de interpretar.

Evite:

- operadores excessivamente aninhados
- metaprogramação desnecessária
- regex complexas sem justificativa
- one-liners difíceis de depurar
- abstrações genéricas excessivas
- magia implícita
- efeitos colaterais escondidos

Código previsível é uma característica de qualidade.

---

## 28. Testes também devem ser humanos

Testes devem explicar comportamento.

Prefira:

```ts
it("does not charge an inactive subscription", () => {
  ...
});
```

a:

```ts
it("testSubscription", () => {
  ...
});
```

Um bom teste deve permitir entender a regra sem abrir a implementação.

Evite mocks excessivos quando um teste mais simples puder validar o comportamento real.

---

## 29. Ao gerar código novo

Antes de finalizar, faça uma revisão mental:

### Clareza

- Consigo entender o fluxo rapidamente?
- Os nomes têm significado?
- Existe nesting desnecessário?

### Complexidade

- Existe abstração que pode desaparecer?
- Existe função que poderia ser simplesmente inline?
- Existe código "esperto" demais?

### Manutenção

- Outra pessoa conseguiria alterar isso?
- Uma regra importante está escondida?
- Os comentários explicam decisões ou apenas repetem código?

### Idiomatismo

- Estou usando os recursos normais da linguagem?
- Estou seguindo os padrões existentes no projeto?

### Escopo

- Fiz somente a mudança necessária?
- Introduzi alguma complexidade que o requisito não pediu?

---

## 30. Regra final

Quando houver duas soluções corretas, prefira aquela que:

- possui menos conceitos
- possui menos abstrações
- possui menos código incidental
- possui nomes mais claros
- possui fluxo mais linear
- possui menos estado implícito
- possui menos dependências
- é mais fácil de depurar
- é mais fácil de modificar manualmente

**Não escreva código para impressionar o compilador.**

**Escreva código para outro humano conseguir trabalhar nele.**
