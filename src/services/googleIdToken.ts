import { createPublicKey, verify as verificarAssinatura, type KeyObject } from "crypto";
import { AppError, getErrorMessage, isRecord } from "../lib/errors";

// Validacao dos ID tokens que o Google manda ao painel do Gmail (complemento
// do Workspace).
//
// Sem biblioteca de proposito: o token e um JWT RS256 assinado com as chaves
// publicas do Google, e o node:crypto ja verifica isso. A google-auth-library
// faria o mesmo, mas puxaria dependencia nova so para estas ~100 linhas.
//
// O que NAO pode faltar (cada item fecha um jeito de forjar a identidade):
//  - so RS256: aceitar o "alg" do cabecalho deixaria passar "none"/HS256;
//  - assinatura conferida com a chave do `kid`, buscada no Google;
//  - emissor do Google, prazo valido e a audiencia esperada.

const URL_CHAVES = "https://www.googleapis.com/oauth2/v3/certs";
const EMISSORES = new Set(["accounts.google.com", "https://accounts.google.com"]);
// Mesma folga que a biblioteca oficial usa para relogio desencontrado.
const FOLGA_RELOGIO_SEG = 300;
const TIMEOUT_CHAVES_MS = 5000;
const CACHE_PADRAO_SEG = 3600;

export interface ClaimsGoogle {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
  email?: string;
  email_verified?: boolean;
  hd?: string;
  azp?: string;
}

type BuscarChave = (kid: string) => Promise<KeyObject | undefined>;

export interface OpcoesVerificacao {
  // Funcao em vez de valor: a audiencia do token de sistema e a URL chamada, e
  // quem sabe o que aceitar e o chamador.
  audiencia: (aud: string) => boolean;
  agoraSeg?: number;
  // So para teste: chaves locais no lugar das do Google.
  buscarChave?: BuscarChave;
}

let cacheChaves: { porKid: Map<string, KeyObject>; expiraEm: number } | null =
  null;

async function baixarChaves(): Promise<Map<string, KeyObject>> {
  const resp = await fetch(URL_CHAVES, {
    signal: AbortSignal.timeout(TIMEOUT_CHAVES_MS),
  });
  if (!resp.ok) throw new Error(`chaves do Google responderam ${resp.status}`);
  const corpo = (await resp.json()) as { keys?: unknown[] };
  const porKid = new Map<string, KeyObject>();
  for (const jwk of corpo.keys || []) {
    if (!isRecord(jwk) || typeof jwk.kid !== "string") continue;
    porKid.set(jwk.kid, createPublicKey({ key: jwk as never, format: "jwk" }));
  }
  // O Google diz no Cache-Control quanto tempo as chaves valem.
  const maxAge = /max-age=(\d+)/.exec(resp.headers.get("cache-control") || "");
  const seg = maxAge ? Number(maxAge[1]) : CACHE_PADRAO_SEG;
  cacheChaves = { porKid, expiraEm: Date.now() + seg * 1000 };
  return porKid;
}

// Se o `kid` nao esta no cache, baixa de novo UMA vez: o Google troca as chaves
// periodicamente e um token novo pode chegar antes do cache vencer.
const chaveDoGoogle: BuscarChave = async (kid) => {
  if (cacheChaves && cacheChaves.expiraEm > Date.now()) {
    const k = cacheChaves.porKid.get(kid);
    if (k) return k;
  }
  return (await baixarChaves()).get(kid);
};

function invalido(motivo: string): AppError {
  return new AppError({
    statusCode: 401,
    code: "ADDON_TOKEN_INVALIDO",
    message: "Não foi possível confirmar que o pedido veio do Google.",
    details: { motivo },
  });
}

function decodificarParte(parte: string): Record<string, unknown> {
  const json = JSON.parse(Buffer.from(parte, "base64url").toString("utf8"));
  if (!isRecord(json)) throw new Error("parte do token nao e objeto");
  return json;
}

export async function verificarIdTokenGoogle(
  token: string,
  opts: OpcoesVerificacao,
): Promise<ClaimsGoogle> {
  const partes = String(token || "").split(".");
  if (partes.length !== 3) throw invalido("formato");

  let cabecalho: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    cabecalho = decodificarParte(partes[0]);
    claims = decodificarParte(partes[1]);
  } catch {
    throw invalido("nao decodifica");
  }

  if (cabecalho.alg !== "RS256") throw invalido(`alg ${String(cabecalho.alg)}`);
  const kid = typeof cabecalho.kid === "string" ? cabecalho.kid : "";
  if (!kid) throw invalido("sem kid");

  let chave: KeyObject | undefined;
  try {
    chave = await (opts.buscarChave || chaveDoGoogle)(kid);
  } catch (error) {
    // Falha de rede ao buscar as chaves nao e token invalido: sobe como 503 para
    // o log separar "Google fora" de "alguem forjando pedido".
    throw new AppError({
      statusCode: 503,
      code: "ADDON_CHAVES_INDISPONIVEIS",
      message: "Não foi possível validar o pedido agora. Tente de novo.",
      details: { causa: getErrorMessage(error) },
    });
  }
  if (!chave) throw invalido("kid desconhecido");

  const assinado = Buffer.from(`${partes[0]}.${partes[1]}`);
  const assinatura = Buffer.from(partes[2], "base64url");
  if (!verificarAssinatura("RSA-SHA256", assinado, chave, assinatura)) {
    throw invalido("assinatura");
  }

  const agora = opts.agoraSeg ?? Math.floor(Date.now() / 1000);
  const exp = Number(claims.exp);
  const iat = Number(claims.iat);
  if (!Number.isFinite(exp) || exp + FOLGA_RELOGIO_SEG < agora) {
    throw invalido("expirado");
  }
  if (Number.isFinite(iat) && iat - FOLGA_RELOGIO_SEG > agora) {
    throw invalido("emitido no futuro");
  }
  if (!EMISSORES.has(String(claims.iss))) throw invalido("emissor");
  const aud = String(claims.aud ?? "");
  if (!aud || !opts.audiencia(aud)) throw invalido(`audiencia ${aud}`);

  return {
    iss: String(claims.iss),
    aud,
    sub: String(claims.sub ?? ""),
    exp,
    iat,
    email: typeof claims.email === "string" ? claims.email : undefined,
    email_verified:
      claims.email_verified === true || claims.email_verified === "true",
    hd: typeof claims.hd === "string" ? claims.hd : undefined,
    azp: typeof claims.azp === "string" ? claims.azp : undefined,
  };
}
