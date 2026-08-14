import { AppError } from "../lib/errors";
import { getEmailByToken, getGmailAccess, getGmailRefresh } from "./store";

// Resolucao da conta Google do usuario, compartilhada pelos fluxos de Gmail e de
// Google Chat. Estava privada no gmail.controller; foi extraida para ca quando a
// aba Chat passou a precisar exatamente da mesma logica.
//
// O codigo de erro continua GMAIL_PERFIL_NAO_CONECTADO de proposito: o app ja
// traduz esse codigo em mensagem amigavel (renderer/app-revisao.js, mensagemErro)
// e a conta e a MESMA para e-mail e chat — mudar o codigo so quebraria a traducao.

export async function resolverContaGoogle(
  profileToken?: string,
  emailParam?: string,
): Promise<string> {
  let email = profileToken
    ? await getEmailByToken(profileToken).catch(() => null)
    : null;
  if (!email && emailParam) {
    const e = String(emailParam).trim().toLowerCase();
    // So aceita o e-mail avulso se aquela conta realmente tiver tokens salvos
    // (isto e, estiver conectada) — senao qualquer e-mail passaria.
    const conectada =
      (await getGmailRefresh(e).catch(() => null)) ||
      (await getGmailAccess(e).catch(() => null));
    if (e && conectada) email = e;
  }
  if (!email) {
    throw new AppError({
      statusCode: 401,
      code: "GMAIL_PERFIL_NAO_CONECTADO",
      message: "Conta Google nao conectada. Conecte em Configurar Perfil.",
    });
  }
  return email;
}
