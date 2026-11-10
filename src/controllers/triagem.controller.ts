import { Request, Response } from "express";
import { AppError } from "../lib/errors";
import { resolverContaGoogle } from "../services/googleConta";
import {
  conferirCaixa,
  estaNoPiloto,
  listarSugestoes,
  MOTIVOS_NAO_E_CHAMADO,
  registrarDesfecho,
} from "../services/triagemPiloto";
import { ensureBodyObject, getOptionalString } from "../utils/request";

// Sugestoes de chamado pela caixa do Gmail (piloto, ver triagemPiloto.ts).
// So pelo profileToken, sem o "?email=" que as rotas antigas aceitam: a
// resposta traz assunto e remetente da caixa de alguem.

// POST /gmail/triagem/conferir { profileToken, setor?, apenasListar? }
// Fora do piloto responde { ativo: false } sem ler a caixa: e assim que o app
// sabe se mostra a secao "Sugeridos".
export async function triagemConferirController(req: Request, res: Response) {
  const body = ensureBodyObject(req.body);
  const email = await resolverContaGoogle(getOptionalString(body, "profileToken") || "");
  if (!(await estaNoPiloto(email))) {
    res.status(200).json({ ok: true, data: { ativo: false } });
    return;
  }
  // Abrir a aba so lista o que ja foi achado; a conferencia de verdade (que le
  // a caixa e gasta IA) vem do relogio do app.
  if (body.apenasListar === true) {
    const sugestoes = await listarSugestoes(email);
    res.status(200).json({ ok: true, data: { ativo: true, sugestoes, conferidoEm: null } });
    return;
  }
  const r = await conferirCaixa(email, { setor: getOptionalString(body, "setor") });
  res.status(200).json({ ok: true, data: { ativo: true, ...r } });
}

// POST /gmail/triagem/desfecho { profileToken, threadId, motivo }
// O "Nao e chamado" do app. "Virou chamado" e anotado na criacao do chamado
// (gmail.controller), e "ignorada" quando a sugestao vence.
export async function triagemDesfechoController(req: Request, res: Response) {
  const body = ensureBodyObject(req.body);
  const email = await resolverContaGoogle(getOptionalString(body, "profileToken") || "");
  const threadId = getOptionalString(body, "threadId");
  const motivo = getOptionalString(body, "motivo");
  if (!threadId) {
    throw new AppError({
      statusCode: 400,
      code: "TRIAGEM_SEM_CONVERSA",
      message: "Informe a conversa (threadId).",
    });
  }
  if (!motivo || !(MOTIVOS_NAO_E_CHAMADO as readonly string[]).includes(motivo)) {
    throw new AppError({
      statusCode: 400,
      code: "TRIAGEM_MOTIVO_INVALIDO",
      message: `Motivo invalido. Use: ${MOTIVOS_NAO_E_CHAMADO.join(", ")}.`,
    });
  }
  await registrarDesfecho(email, threadId, "nao_e_chamado", motivo);
  res.status(200).json({ ok: true, data: { sugestoes: await listarSugestoes(email) } });
}
