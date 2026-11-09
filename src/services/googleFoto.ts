import { AppError, getErrorMessage } from "../lib/errors";
import { getValidAccessToken, USERINFO_URI } from "./gmailAuth";

// Foto da conta Google para o seletor de contas do app (avatar no topo).
//
// Duas fontes, nesta ordem (decidido em 09/11/2026):
// 1. Diretorio da empresa (People API, escopo directory.readonly que o Chat ja
//    pede): serve quem ja esta conectado, sem precisar reconectar.
// 2. userinfo (escopo profile, pedido no login a partir desta mudanca): cobre
//    quem nao liberou o Chat ou cujo perfil nao aparece no diretorio.
//
// A foto volta como data URL (os bytes, nao o link): o app guarda junto da
// conta e mostra sem rede, e a CSP dele ja aceita data: em img-src.

const PEOPLE_API = "https://people.googleapis.com/v1";
const TIMEOUT_MS = 8000;
// O avatar do app tem ate 36px; 96 fica nitido mesmo com zoom de tela.
const TAMANHO_PX = 96;
// Uma foto de 96px tem poucos KB. Muito acima disso, veio outra coisa.
const MAX_BYTES = 200 * 1024;

export type OrigemFoto = "diretorio" | "perfil";
export interface FotoGoogle {
  foto: string | null;
  origem: OrigemFoto | null;
}

interface FotoPeople {
  url?: string;
  default?: boolean;
}

function erroFoto(message: string, details?: unknown): AppError {
  return new AppError({
    statusCode: 502,
    code: "GOOGLE_FOTO_ERRO",
    message,
    details,
  });
}

// "default: true" e o avatar de letra que o Google gera para quem nao tem
// foto. O app ja desenha a inicial nesse caso, entao nao vale baixar.
function primeiraFotoReal(fotos?: FotoPeople[]): string | null {
  const foto = (fotos || []).find((f) => f?.url && !f.default);
  return foto?.url || null;
}

async function fotoDoDiretorio(
  email: string,
  token: string,
): Promise<string | null> {
  const url = new URL(`${PEOPLE_API}/people:searchDirectoryPeople`);
  url.searchParams.set("query", email);
  url.searchParams.set("readMask", "photos,emailAddresses");
  url.searchParams.set("sources", "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE");
  url.searchParams.set("pageSize", "5");

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 403 = a conta nao tem o escopo do diretorio (nao liberou o Chat). E o
  // caso esperado para essas contas: a foto vem do userinfo.
  if (resp.status === 403) return null;
  if (!resp.ok) {
    throw erroFoto(
      `Diretorio do Google respondeu HTTP ${resp.status}.`,
      await resp.json().catch(() => undefined),
    );
  }
  const data = (await resp.json()) as {
    people?: Array<{
      photos?: FotoPeople[];
      emailAddresses?: Array<{ value?: string }>;
    }>;
  };
  // A busca e por texto: confere o e-mail para nao pegar a foto de um xara.
  const pessoa = (data.people || []).find((p) =>
    (p.emailAddresses || []).some(
      (e) => String(e?.value || "").trim().toLowerCase() === email,
    ),
  );
  return primeiraFotoReal(pessoa?.photos);
}

async function fotoDoPerfil(
  email: string,
  token: string,
): Promise<string | null> {
  const resp = await fetch(USERINFO_URI, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw erroFoto(
      `userinfo do Google respondeu HTTP ${resp.status} para ${email}.`,
      await resp.json().catch(() => undefined),
    );
  }
  const data = (await resp.json()) as { picture?: string };
  // Sem o escopo profile o campo nem vem.
  return String(data?.picture || "") || null;
}

// So baixa do servidor de imagens do Google: a URL vem de uma resposta do
// Google, mas o backend nao deve buscar endereco arbitrario por ninguem.
function urlDeFotoDoGoogle(bruta: string): URL | null {
  try {
    const url = new URL(bruta);
    if (url.protocol !== "https:") return null;
    if (!url.hostname.endsWith(".googleusercontent.com")) return null;
    // As URLs terminam em "=s100" / "=s96-c" (tamanho). Pede o do avatar.
    url.pathname = url.pathname.replace(/=s\d+(-c)?$/, `=s${TAMANHO_PX}-c`);
    return url;
  } catch {
    return null;
  }
}

async function baixarComoDataUrl(bruta: string): Promise<string> {
  const url = urlDeFotoDoGoogle(bruta);
  if (!url) throw erroFoto("Endereco de foto fora do Google.", { url: bruta });

  const resp = await fetch(url.toString(), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw erroFoto(`Download da foto respondeu HTTP ${resp.status}.`);
  }
  const tipo = String(resp.headers.get("content-type") || "")
    .split(";")[0]
    .trim();
  if (!tipo.startsWith("image/")) {
    throw erroFoto(`Download da foto devolveu "${tipo || "sem tipo"}".`);
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) {
    throw erroFoto(`Foto com ${bytes.length} bytes, fora do esperado.`);
  }
  return `data:${tipo};base64,${bytes.toString("base64")}`;
}

export async function buscarFotoGoogle(email: string): Promise<FotoGoogle> {
  const token = await getValidAccessToken(email);

  let url: string | null = null;
  let origem: OrigemFoto | null = null;
  let falhaDiretorio: unknown = null;
  try {
    url = await fotoDoDiretorio(email, token);
    if (url) origem = "diretorio";
  } catch (error) {
    // Nao para aqui: o userinfo ainda pode ter a foto.
    falhaDiretorio = error;
    console.warn(`[foto] diretorio falhou para ${email}:`, getErrorMessage(error));
  }
  if (!url) {
    url = await fotoDoPerfil(email, token);
    if (url) origem = "perfil";
  }
  if (!url) {
    // A foto pode existir e so o diretorio ter falhado: devolve o erro para o
    // app tentar de novo depois, em vez de um "sem foto" que ele guardaria.
    if (falhaDiretorio) throw falhaDiretorio;
    return { foto: null, origem: null };
  }
  return { foto: await baixarComoDataUrl(url), origem };
}
