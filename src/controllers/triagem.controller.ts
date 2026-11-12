import { Request, Response } from "express";
import { AppError } from "../lib/errors";
import { registrarVistoAppNoFundo } from "../services/appOnline";
import { resolverContaGoogle } from "../services/googleConta";
import { ramalDaConta } from "./gmailAddon.controller";
import {
  conferirCaixa,
  desfechoDoMotivo,
  estaNoPiloto,
  limiarDaPessoa,
  listarSugestoes,
  MOTIVOS_PARA_O_APP,
  registrarDesfecho,
} from "../services/triagemPiloto";
import { ensureBodyObject, getOptionalString } from "../utils/request";

// Sugestoes de chamado pela caixa do Gmail (piloto, ver triagemPiloto.ts).
// So pelo profileToken, sem o "?email=" que as rotas antigas aceitam: a
// resposta traz assunto e remetente da caixa de alguem.

// O profileToken -> e-mail nunca muda (nada apaga gmail:profile:*), e todo app
// pergunta a cada conferencia: guardar na memoria da funcao poupa um comando
// do Redis por conferencia. 12 h, e nao minutos, porque cada app pergunta a
// cada 20 min: um cache mais curto que isso nunca acertaria. So guarda o que
// resolveu.
const CONTA_CACHE_MS = 12 * 3600_000;
const contaDoToken = new Map<string, { email: string; em: number }>();

async function contaDaTriagem(profileToken: string): Promise<string> {
  const guardada = profileToken ? contaDoToken.get(profileToken) : undefined;
  if (guardada && Date.now() - guardada.em < CONTA_CACHE_MS) return guardada.email;
  const email = await resolverContaGoogle(profileToken);
  contaDoToken.set(profileToken, { email, em: Date.now() });
  return email;
}

// POST /gmail/triagem/conferir { profileToken, setor?, apenasListar? }
// Fora do piloto responde { ativo: false } sem ler a caixa: e assim que o app
// sabe se mostra a secao "Sugeridos". No piloto, a resposta leva tambem os
// motivos do "Nao e chamado", para o app desenhar os botoes.
export async function triagemConferirController(req: Request, res: Response) {
  const body = ensureBodyObject(req.body);
  const email = await contaDaTriagem(getOptionalString(body, "profileToken") || "");
  // Aba "Online" do /admin: esta conferencia sai sozinha ~20 s depois de o app
  // abrir, de todo mundo com conta Google (no piloto ou nao), e traz o setor.
  // Em segundo plano: nao atrasa a resposta.
  registrarVistoAppNoFundo({
    userAgent: req.header("user-agent"),
    conta: email,
    setor: getOptionalString(body, "setor"),
    ramalDaConta: () => ramalDaConta(email),
  });
  if (!(await estaNoPiloto(email))) {
    res.status(200).json({ ok: true, data: { ativo: false } });
    return;
  }
  // Abrir a aba so lista o que ja foi achado; a conferencia de verdade (que le
  // a caixa e gasta IA) vem do relogio do app.
  // "limiar" = confianca minima desta pessoa (sobe para quem dispensa muito).
  // O app esconde as sugestoes abaixo dele e so avisa das que passam.
  if (body.apenasListar === true) {
    const [sugestoes, limiar] = await Promise.all([listarSugestoes(email), limiarDaPessoa(email)]);
    res.status(200).json({
      ok: true,
      data: { ativo: true, sugestoes, conferidoEm: null, motivos: MOTIVOS_PARA_O_APP, limiar },
    });
    return;
  }
  // O limiar vem dentro do resultado (lido junto com o cursor).
  const r = await conferirCaixa(email, { setor: getOptionalString(body, "setor") });
  res.status(200).json({ ok: true, data: { ativo: true, ...r, motivos: MOTIVOS_PARA_O_APP } });
}

// POST /gmail/triagem/desfecho { profileToken, threadId, motivo }
// Os botoes do "Nao e chamado" do app. Cada motivo grava o seu desfecho (ver
// MOTIVOS_NAO_E_CHAMADO): "nao e para mim" e "ja virou chamado" nao sao
// exemplo de "nao e chamado" para o aprendizado. "Virou chamado" e anotado na
// criacao do chamado (gmail.controller), e "ignorada" quando a sugestao vence.
export async function triagemDesfechoController(req: Request, res: Response) {
  const body = ensureBodyObject(req.body);
  const email = await contaDaTriagem(getOptionalString(body, "profileToken") || "");
  const threadId = getOptionalString(body, "threadId");
  const motivo = getOptionalString(body, "motivo") || "";
  if (!threadId) {
    throw new AppError({
      statusCode: 400,
      code: "TRIAGEM_SEM_CONVERSA",
      message: "Informe a conversa (threadId).",
    });
  }
  const desfecho = desfechoDoMotivo(motivo);
  if (!desfecho) {
    throw new AppError({
      statusCode: 400,
      code: "TRIAGEM_MOTIVO_INVALIDO",
      message: `Motivo invalido. Use: ${MOTIVOS_PARA_O_APP.map((m) => m.valor).join(", ")}.`,
    });
  }
  await registrarDesfecho(email, threadId, desfecho, motivo);
  res.status(200).json({ ok: true, data: { sugestoes: await listarSugestoes(email) } });
}
