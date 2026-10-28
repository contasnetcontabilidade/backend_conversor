import { Router } from "express";
import { gmailAddonController } from "../controllers/gmailAddon.controller";

// Rotas do painel do Gmail (complemento do Google Workspace).
//
// Ficam FORA do apiRouter de proposito: quem chama e o Google, que nao manda o
// x-app-token. A autenticacao daqui e propria (ID tokens do Google, conferidos
// no controller) e obrigatoria — diferente do appAuth, que hoje esta dormante.
export const addonRouter = Router();

addonRouter.post("/gmail/:acao", gmailAddonController);
