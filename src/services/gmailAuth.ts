import { AppError, getErrorMessage } from "../lib/errors";
import {
  getGmailAccess,
  getGmailRefresh,
  saveGmailAccess,
  saveGmailRefresh,
} from "./store";

// OAuth 2.0 (Authorization Code) do Google/Gmail, POR USUARIO. Cada pessoa
// autoriza a propria caixa; guardamos o refresh token dela (chaveado pelo e-mail)
// e geramos access tokens sob demanda. Escopo: SOMENTE LEITURA do Gmail.

const AUTH_BASE =
  process.env.GMAIL_AUTH_BASE || "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URI =
  process.env.GMAIL_TOKEN_URI || "https://oauth2.googleapis.com/token";
const USERINFO_URI = "https://www.googleapis.com/oauth2/v3/userinfo";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "openid",
  "email",
];

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

export function buildAuthorizeUrl(state: string): string {
  const clientId = requireEnv("GMAIL_CLIENT_ID");
  const redirectUri = requireEnv("GMAIL_REDIRECT_URI");
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: GMAIL_SCOPES.join(" "),
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
