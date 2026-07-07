import { AppError, getErrorMessage } from "../lib/errors";
import {
  getAccessToken,
  getRefreshToken,
  saveAccessToken,
  saveRefreshToken,
} from "./store";

// OAuth 2.0 (Authorization Code) do GoTo. Um super-admin autoriza uma vez;
// guardamos o refresh token e geramos access tokens (1h) sob demanda.
// Docs: https://developer.goto.com/guides/Authentication/03_HOW_accessToken

const AUTH_BASE =
  process.env.GOTO_AUTH_BASE || "https://authentication.logmeininc.com";

export const GOTO_SCOPES = [
  "call-events.v1.events.read",
  "call-events.v1.notifications.manage",
  "cr.v1.read",
  "voice-admin.v1.read",
];

interface GotoTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new AppError({
      statusCode: 500,
      code: "GOTO_ENV_MISSING",
      message: `Variavel de ambiente ${name} nao configurada.`,
    });
  }
  return value;
}

function basicAuthHeader(): string {
  const clientId = requireEnv("GOTO_CLIENT_ID");
  const clientSecret = requireEnv("GOTO_CLIENT_SECRET");
  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  return `Basic ${encoded}`;
}

export function buildAuthorizeUrl(state: string): string {
  const clientId = requireEnv("GOTO_CLIENT_ID");
  const redirectUri = requireEnv("GOTO_REDIRECT_URI");
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: GOTO_SCOPES.join(" "),
    state,
  });
  return `${AUTH_BASE}/oauth/authorize?${params.toString()}`;
}

async function requestToken(
  body: Record<string, string>,
): Promise<GotoTokenResponse> {
  const response = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
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
      code: "GOTO_TOKEN_ERROR",
      message: `Falha ao obter token do GoTo (HTTP ${response.status}).`,
      details: payload,
    });
  }

  return payload as GotoTokenResponse;
}

// Troca o "code" do callback por tokens e persiste o refresh token.
export async function exchangeCodeForTokens(
  code: string,
): Promise<GotoTokenResponse> {
  const redirectUri = requireEnv("GOTO_REDIRECT_URI");
  const tokens = await requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  if (tokens.refresh_token) {
    await saveRefreshToken(tokens.refresh_token);
  }
  await saveAccessToken(tokens.access_token, tokens.expires_in);
  return tokens;
}

// Cache do access token em memoria (resiliente a store indisponivel).
let memAccessToken: { token: string; expiresAt: number } | null = null;

async function readStoredRefreshToken(): Promise<string | null> {
  try {
    const stored = await getRefreshToken();
    if (stored) return stored;
  } catch (error) {
    console.warn("[goto] store de refresh indisponivel:", getErrorMessage(error));
  }
  // Fallback: refresh token semeado via env (super-admin ja autorizou fora do fluxo).
  return process.env.GOTO_REFRESH_TOKEN || null;
}

// Gera um novo access token a partir do refresh token (store ou env).
async function refreshAccessToken(): Promise<string> {
  const refreshToken = await readStoredRefreshToken();
  if (!refreshToken) {
    throw new AppError({
      statusCode: 401,
      code: "GOTO_NOT_AUTHORIZED",
      message:
        "GoTo nao autorizado. Defina GOTO_REFRESH_TOKEN ou acesse /api/goto/oauth/start.",
    });
  }

  const tokens = await requestToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
    await saveRefreshToken(tokens.refresh_token).catch(() => undefined);
  }
  memAccessToken = {
    token: tokens.access_token,
    expiresAt: Date.now() + Math.max(30, tokens.expires_in - 60) * 1000,
  };
  await saveAccessToken(tokens.access_token, tokens.expires_in).catch(
    () => undefined,
  );
  return tokens.access_token;
}

// Retorna um access token valido (memoria -> store -> renova).
export async function getValidAccessToken(): Promise<string> {
  if (memAccessToken && Date.now() < memAccessToken.expiresAt) {
    return memAccessToken.token;
  }
  try {
    const cached = await getAccessToken();
    if (cached) return cached;
  } catch (error) {
    console.warn("[goto] cache de token indisponivel:", getErrorMessage(error));
  }
  return refreshAccessToken();
}
