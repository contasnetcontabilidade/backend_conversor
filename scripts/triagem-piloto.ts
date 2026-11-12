// Quem participa do piloto da triagem de e-mails (tabela triagem_piloto no
// Supabase, ver src/services/triagemPiloto.ts). Muda na hora, sem deploy: na
// proxima conferencia o app da pessoa mostra (ou esconde) os "Sugeridos".
// Precisa de SUPABASE_URL e SUPABASE_SECRET_KEY no .env.
//
// Uso (na pasta do backend):
//   ENV_FILE=../.env npx tsx scripts/triagem-piloto.ts listar
//   ENV_FILE=../.env npx tsx scripts/triagem-piloto.ts entrar a@contas.com.br [b@contas.com.br ...]
//   ENV_FILE=../.env npx tsx scripts/triagem-piloto.ts sair a@contas.com.br
import dotenv from "dotenv";

dotenv.config({ path: process.env.ENV_FILE || ".env" });

async function main() {
  const [acao, ...emails] = process.argv.slice(2);
  const piloto = await import("../src/services/triagemPiloto");
  if (acao === "entrar" || acao === "sair") {
    if (!emails.length) throw new Error(`Informe o(s) e-mail(s) para ${acao}.`);
    for (const e of emails) {
      if (!/^[^@\s]+@[^@\s]+$/.test(e)) throw new Error(`E-mail invalido: ${e}`);
      await (acao === "entrar" ? piloto.entrarNoPiloto(e) : piloto.sairDoPiloto(e));
    }
  } else if (acao !== "listar") {
    throw new Error("Use: listar | entrar <email...> | sair <email...>");
  }
  const lista = await piloto.listarPiloto();
  console.log(`No piloto (${lista.length}): ${lista.join(", ") || "ninguem"}`);
}

main().catch((e) => {
  console.error(`[triagem-piloto] ${(e as Error).message}`);
  process.exit(1);
});
