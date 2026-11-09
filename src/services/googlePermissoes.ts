import { escoposSolicitados, getEscoposConcedidos } from "./gmailAuth";

// O que falta a conta liberar no Google para o app funcionar inteiro.
//
// Quando o login passa a pedir um escopo novo (o "profile" da foto, em
// 09/11/2026), quem conectou antes so ganha esse escopo reconectando. O app
// mostra uma bolinha no avatar e um aviso no menu de contas com o que falta,
// e o texto sai daqui: assim um escopo novo no futuro nao exige versao nova
// do app, so este mapa.

export interface Pendencia {
  chave: string;
  nome: string; // "a sua foto" — entra em "Falta liberar: ..."
  para: string; // "mostrar a sua foto no app" — entra em "...uma permissao para ..."
}

const RECURSOS: Array<Pendencia & { cobre: (escopo: string) => boolean }> = [
  {
    chave: "gmail",
    nome: "os e-mails",
    para: "ler os e-mails marcados com Chamado",
    cobre: (s) => s.includes("/auth/gmail."),
  },
  {
    chave: "chat",
    nome: "o Chat",
    para: "abrir chamados pelo Google Chat",
    // directory.readonly so existe para resolver o nome de quem fala no Chat.
    cobre: (s) => s.includes("/auth/chat.") || s.endsWith("/auth/directory.readonly"),
  },
  {
    chave: "foto",
    nome: "a sua foto",
    para: "mostrar a sua foto no app",
    cobre: (s) => s.endsWith("/auth/userinfo.profile"),
  },
];

// O login pede "email" e "profile", mas o Google devolve os nomes longos.
const NOME_LONGO: Record<string, string> = {
  email: "https://www.googleapis.com/auth/userinfo.email",
  profile: "https://www.googleapis.com/auth/userinfo.profile",
};
const normalizar = (escopo: string) => NOME_LONGO[escopo] || escopo;

export async function pendenciasDaConta(
  email: string,
): Promise<{ conferido: boolean; faltam: Pendencia[] }> {
  const concedidos = new Set((await getEscoposConcedidos(email)).map(normalizar));
  // Sem nenhum escopo conhecido nao da para afirmar nada: em vez de mandar
  // todo mundo reconectar por uma consulta que falhou, diz que nao conferiu
  // (o app registra e mantem o que sabia antes).
  if (!concedidos.size) {
    console.warn(`[permissoes] escopos de ${email} desconhecidos; nao conferido`);
    return { conferido: false, faltam: [] };
  }
  const faltando = escoposSolicitados()
    .map(normalizar)
    .filter((s) => !concedidos.has(s));
  const faltam = RECURSOS.filter((r) => faltando.some(r.cobre)).map(
    ({ chave, nome, para }) => ({ chave, nome, para }),
  );
  return { conferido: true, faltam };
}
