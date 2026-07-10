import { NextFunction, Request, Response } from "express";

// Autenticacao por token compartilhado do app (sem login por usuario).
// O desktop envia o header "x-app-token"; o backend compara com API_AUTH_TOKEN.
//
// DORMANTE por padrao: se API_AUTH_TOKEN NAO estiver definido no ambiente, tudo
// passa (util em dev/teste). Ao definir API_AUTH_TOKEN (ex.: na Vercel), a
// protecao liga para todas as rotas, exceto as externas/self-auth abaixo.

// Rotas que NAO exigem o token (chamadas externas ou com auth propria).
function isExempt(path: string): boolean {
  return (
    path === "/health" ||
    path.startsWith("/goto/webhook/") || // GoTo (token na URL)
    path.startsWith("/goto/oauth/") || // fluxo OAuth no navegador
    path.startsWith("/goto/setup/") ||
    path === "/admin" || // pagina do painel (login proprio)
    path === "/admin/uso" // protegida por senha (Authorization Bearer)
  );
}

export function appAuth(req: Request, res: Response, next: NextFunction) {
  const expected = (process.env.API_AUTH_TOKEN || "").trim();
  if (!expected) return next(); // sem token configurado -> aberto (dev/teste)
  if (req.method === "OPTIONS") return next();
  if (isExempt(req.path)) return next();

  const token = (req.header("x-app-token") || "").trim();
  if (token && token === expected) return next();

  res.status(401).json({
    ok: false,
    error: {
      code: "APP_UNAUTHORIZED",
      message: "Acesso nao autorizado.",
    },
  });
}
