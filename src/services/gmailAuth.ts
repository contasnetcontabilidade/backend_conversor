import { AppError, getErrorMessage } from "../lib/errors";
import {
  getGmailAccess,
  getGmailRefresh,
  getGoogleScopes,
  limparGoogleScopes,
  saveGmailAccess,
  saveGmailRefresh,
  saveGoogleScopes,
} from "./store";

// OAuth 2.0 (Authorization Code) do Google/Gmail, POR USUARIO. Cada pessoa
// autoriza a propria caixa; guardamos o refresh token dela (chaveado pelo e-mail)
// e geramos access tokens sob demanda. Escopo: SOMENTE LEITURA do Gmail.

const AUTH_BASE =
  process.env.GMAIL_AUTH_BASE || "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URI =
  process.env.GMAIL_TOKEN_URI || "https://oauth2.googleapis.com/token";
const USERINFO_URI = "https://www.googleapis.com/oauth2/v3/userinfo";
const TOKENINFO_URI = "https://oauth2.googleapis.com/tokeninfo";

export const GMAIL_SCOPES = [
  // modify = ler e-mails + criar/aplicar/remover marcadores (NAO apaga e-mails).
  "https://www.googleapis.com/auth/gmail.modify",
  "openid",
  "email",
];

// Escopos do GOOGLE CHAT (aba "Chat": abrir chamado a partir de conversas).
// chat.messages.readonly e RESTRITO pelo Google; os demais sao sensiveis. Como a
// tela de consentimento do projeto e INTERNA (so contas da organizacao), nao ha
// verificacao do Google nem avaliacao CASA — mesmo caminho do gmail.modify, que
// tambem e restrito e ja roda em producao.
export const CHAT_SCOPES = [
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.messages.readonly",
  // memberships: resolve o NOME de quem enviou (sender.displayName vem vazio as vezes).
  "https://www.googleapis.com/auth/chat.memberships.readonly",
  // sections: le a secao "Chamado" — o analogo do marcador do Gmail.
  "https://www.googleapis.com/auth/chat.users.sections",
  // A Chat API NAO devolve o nome de quem enviou (com auth de usuario o objeto
  // User vem so com id e tipo). A propria doc do Google manda resolver pela
  // People API: users/123 no Chat = people/123 na People API. Sem isto o chamado
  // sairia com "Participante 1146" no lugar do nome do colega.
  "https://www.googleapis.com/auth/directory.readonly",
];

// Escopo usado como sentinela de "esta conta ja autorizou o Chat".
const CHAT_SCOPE_SENTINELA = "https://www.googleapis.com/auth/chat.messages.readonly";

// Padrao LIGADO. Pre-requisito: a Chat API habilitada no Google Cloud e os
// escopos cadastrados na tela de consentimento — sem isso o Google recusa a
// autorizacao INTEIRA, e quem reconectar perde tambem o Gmail.
// CHAT_SCOPES_ENABLED=0 e o rollback de 1 variavel: volta a pedir so o Gmail,
// as rotas /api/chat/* respondem CHAT_SCOPE_MISSING e a aba se auto-desabilita.
export function chatHabilitado(): boolean {
  return String(process.env.CHAT_SCOPES_ENABLED ?? "1").trim() !== "0";
}

export function escoposSolicitados(comChat = chatHabilitado()): string[] {
  return comChat ? [...GMAIL_SCOPES, ...CHAT_SCOPES] : [...GMAIL_SCOPES];
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  id_token?: string;
  scope?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new AppError({
      statusCode: 500,
      code: "GMAIL_ENV_MISSING",
      message: `Variavel de ambiente ${name} nao configurada.`,
    });
  }
  return value;
}

export function buildAuthorizeUrl(
  state: string,
  opts: { comChat?: boolean } = {},
): string {
  const clientId = requireEnv("GMAIL_CLIENT_ID");
  const redirectUri = requireEnv("GMAIL_REDIRECT_URI");
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    // include_granted_scopes=true faz o novo consentimento ser a UNIAO dos
    // escopos: quem reconecta para liberar o Chat NAO perde o Gmail.
    scope: escoposSolicitados(opts.comChat).join(" "),
    access_type: "offline", // pede refresh token
    prompt: "consent", // garante o refresh token mesmo em reautorizacao
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

async function requestToken(
  body: Record<string, string>,
): Promise<GoogleTokenResponse> {
  const clientId = requireEnv("GMAIL_CLIENT_ID");
  const clientSecret = requireEnv("GMAIL_CLIENT_SECRET");
  const response = await fetch(TOKEN_URI, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      ...body,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new AppError({
      statusCode: 502,
      code: "GMAIL_TOKEN_ERROR",
      message: `Falha ao obter token do Google (HTTP ${response.status}).`,
      details: payload,
    });
  }
  return payload as GoogleTokenResponse;
}

// Descobre o e-mail da conta autenticada (userinfo).
async function fetchEmail(accessToken: string): Promise<string> {
  const resp = await fetch(USERINFO_URI, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const data = (await resp.json().catch(() => ({}))) as { email?: string };
  const email = String(data?.email || "")
    .trim()
    .toLowerCase();
  if (!email) {
    throw new AppError({
      statusCode: 502,
      code: "GMAIL_USERINFO_ERROR",
      message: "Nao foi possivel obter o e-mail da conta Google.",
    });
  }
  return email;
}

// Troca o "code" do callback por tokens, descobre o e-mail e persiste o
// refresh token dele (chaveado pelo e-mail). Devolve o e-mail identificado.
export async function exchangeCodeForTokens(
  code: string,
): Promise<{ email: string }> {
  const redirectUri = requireEnv("GMAIL_REDIRECT_URI");
  const tokens = await requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const email = await fetchEmail(tokens.access_token);
  if (tokens.refresh_token) {
    await saveGmailRefresh(email, tokens.refresh_token);
  }
  await saveGmailAccess(email, tokens.access_token, tokens.expires_in);
  // Guarda os escopos REALMENTE concedidos: e assim que o app sabe, sem gastar
  // uma chamada, se aquela conta ja liberou o Chat ou precisa reconectar.
  if (tokens.scope) {
    await saveGoogleScopes(email, tokens.scope).catch(() => undefined);
  }
  return { email };
}

// Cache do access token POR e-mail (resiliente a store indisponivel).
const memAccess = new Map<string, { token: string; expiresAt: number }>();

async function refreshAccessToken(email: string): Promise<string> {
  const refreshToken = await getGmailRefresh(email).catch(() => null);
  if (!refreshToken) {
    throw new AppError({
      statusCode: 401,
      code: "GMAIL_NOT_AUTHORIZED",
      message: `Conta Google ${email} nao autorizada. Reconecte no app (Configurar Perfil).`,
    });
  }
  const tokens = await requestToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  // O Google normalmente NAO devolve novo refresh token no refresh; guarda se vier.
  if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
    await saveGmailRefresh(email, tokens.refresh_token).catch(() => undefined);
  }
  if (tokens.scope) {
    await saveGoogleScopes(email, tokens.scope).catch(() => undefined);
  }
  memAccess.set(email, {
    token: tokens.access_token,
    expiresAt: Date.now() + Math.max(30, tokens.expires_in - 60) * 1000,
  });
  await saveGmailAccess(email, tokens.access_token, tokens.expires_in).catch(
    () => undefined,
  );
  return tokens.access_token;
}

// Access token valido para um e-mail (memoria -> store -> renova).
export async function getValidAccessToken(email: string): Promise<string> {
  const cached = memAccess.get(email);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  try {
    const stored = await getGmailAccess(email);
    if (stored) return stored;
  } catch (error) {
    console.warn("[gmail] cache de token indisponivel:", getErrorMessage(error));
  }
  return refreshAccessToken(email);
}


// ---------------------------------------------------------------------------
// Escopos concedidos: a conta ja autorizou o Google Chat?
// ---------------------------------------------------------------------------

// Le os escopos do access token direto do Google. Usado so para contas ANTIGAS,
// conectadas antes do Chat existir, que nao tem o registro no Redis. Determinis-
// tico e barato — melhor do que descobrir levando 403 no meio da tela do usuario.
async function consultarEscoposNoGoogle(email: string): Promise<string> {
  try {
    const token = await getValidAccessToken(email);
    const resp = await fetch(
      `${TOKENINFO_URI}?access_token=${encodeURIComponent(token)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!resp.ok) return "";
    const data = (await resp.json().catch(() => ({}))) as { scope?: string };
    return String(data?.scope || "");
  } catch {
    return "";
  }
}

// Escopos concedidos por uma conta: Redis -> tokeninfo (e cacheia por 24h).
export async function getEscoposConcedidos(email: string): Promise<string[]> {
  let bruto = await getGoogleScopes(email).catch(() => null);
  if (!bruto) {
    bruto = await consultarEscoposNoGoogle(email);
    if (bruto) {
      await saveGoogleScopes(email, bruto, 24 * 3600).catch(() => undefined);
    }
  }
  return String(bruto || "")
    .split(/\s+/)
    .filter(Boolean);
}

export async function temEscopoChat(email: string): Promise<boolean> {
  if (!chatHabilitado()) return false;
  const escopos = await getEscoposConcedidos(email);
  return escopos.includes(CHAT_SCOPE_SENTINELA);
}

// Chamado quando o Google responde 403 de escopo insuficiente: o registro local
// esta desatualizado (ex.: o admin revogou o acesso). Invalida para a proxima
// consulta ir ao tokeninfo em vez de repetir a informacao velha.
export async function invalidarEscopos(email: string): Promise<void> {
  await limparGoogleScopes(email).catch(() => undefined);
}
