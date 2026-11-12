import { NextFunction, Request, Response } from "express";
import { registrarVistoAppNoFundo } from "../services/appOnline";

// Anota a versao do app (User-Agent) de quem chama com o ramal no corpo JSON
// ou na query: previa, criar chamado, resumo e feedback. E o que da a versao
// de quem nao tem conta Google; a conferencia das Sugestoes cobre o resto
// (ver appOnline.ts). Upload multipart nao entra: o corpo so e lido depois,
// pelo multer da rota.
//
// Nao custa nada na maioria das chamadas: sem versao no User-Agent, ou ja
// anotada na ultima hora, nem chega ao Redis.
export function versaoApp(req: Request, _res: Response, next: NextFunction) {
  try {
    const corpo = req.body && typeof req.body === "object" ? req.body : {};
    const ramal = corpo.ramal ?? req.query.ramal;
    if (typeof ramal === "string" && ramal.trim()) {
      registrarVistoAppNoFundo({ userAgent: req.header("user-agent"), ramal });
    }
  } catch (err) {
    console.warn("[online] middleware de versao falhou:", err);
  }
  next();
}
