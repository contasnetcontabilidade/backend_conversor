import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "crypto";
import { verificarIdTokenGoogle } from "./googleIdToken";

// Chaves geradas na hora: o teste nao depende de rede nem de token real.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const outra = generateKeyPairSync("rsa", { modulusLength: 2048 });
const AGORA = 1_800_000_000;
const AUD = "https://backend.exemplo/api/addon/gmail/email";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function token(
  claims: Record<string, unknown> = {},
  opts: { alg?: string; kid?: string; chave?: KeyObject } = {},
): string {
  const cab = b64({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" });
  const corpo = b64({
    iss: "https://accounts.google.com",
    aud: AUD,
    sub: "123",
    email: "addon@projeto.iam.gserviceaccount.com",
    email_verified: true,
    iat: AGORA - 10,
    exp: AGORA + 3600,
    ...claims,
  });
  const ass = sign("RSA-SHA256", Buffer.from(`${cab}.${corpo}`), opts.chave ?? privateKey);
  return `${cab}.${corpo}.${ass.toString("base64url")}`;
}

const opcoes = {
  audiencia: (aud: string) => aud === AUD,
  agoraSeg: AGORA,
  buscarChave: async (kid: string) => (kid === "k1" ? publicKey : undefined),
};

async function motivo(t: string, o = opcoes): Promise<string> {
  try {
    await verificarIdTokenGoogle(t, o);
    return "aceito";
  } catch (error) {
    return (error as { details?: { motivo?: string } }).details?.motivo || "erro";
  }
}

test("aceita token valido e devolve as claims", async () => {
  const c = await verificarIdTokenGoogle(token(), opcoes);
  assert.equal(c.email, "addon@projeto.iam.gserviceaccount.com");
  assert.equal(c.email_verified, true);
  assert.equal(c.aud, AUD);
});

test("recusa assinatura de outra chave", async () => {
  assert.equal(await motivo(token({}, { chave: outra.privateKey })), "assinatura");
});

test("recusa alg diferente de RS256 (alg none / HS256)", async () => {
  assert.equal(await motivo(token({}, { alg: "none" })), "alg none");
  assert.equal(await motivo(token({}, { alg: "HS256" })), "alg HS256");
});

test("recusa corpo adulterado depois de assinado", async () => {
  const [cab, , ass] = token().split(".");
  const corpo = b64({ iss: "https://accounts.google.com", aud: AUD, email: "outro@x.com", exp: AGORA + 60 });
  assert.equal(await motivo(`${cab}.${corpo}.${ass}`), "assinatura");
});

test("recusa kid desconhecido", async () => {
  assert.equal(await motivo(token({}, { kid: "zz" })), "kid desconhecido");
});

test("recusa expirado, mas tolera a folga de relogio", async () => {
  assert.equal(await motivo(token({ exp: AGORA - 301 })), "expirado");
  assert.equal(await motivo(token({ exp: AGORA - 100 })), "aceito");
});

test("recusa emissor e audiencia errados", async () => {
  assert.equal(await motivo(token({ iss: "https://evil.example" })), "emissor");
  assert.equal(
    await motivo(token({ aud: "https://outro.app/x" })),
    "audiencia https://outro.app/x",
  );
});

test("lixo no lugar do token", async () => {
  assert.equal(await motivo("abc"), "formato");
  assert.equal(await motivo("a.b.c"), "nao decodifica");
});

test("falha ao buscar as chaves vira 503, nao token invalido", async () => {
  await assert.rejects(
    verificarIdTokenGoogle(token(), {
      ...opcoes,
      buscarChave: async () => {
        throw new Error("rede caiu");
      },
    }),
    (e: { code?: string; statusCode?: number }) =>
      e.code === "ADDON_CHAVES_INDISPONIVEIS" && e.statusCode === 503,
  );
});
