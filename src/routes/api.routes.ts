import { Router } from "express";
import {
  healthController,
  processarUploadController,
  processarController,
  resumoController,
  transcricaoController,
} from "../controllers/api.controller";
import {
  gotoAblyTokenController,
  gotoChamadoController,
  gotoEventosController,
  gotoGravacaoController,
  gotoHistoricoController,
  gotoOAuthCallbackController,
  gotoOAuthStartController,
  gotoSetupController,
  gotoWebhookController,
} from "../controllers/goto.controller";
import {
  adminPageController,
  adminUsoController,
  adminFeedbackController,
  adminErrosController,
  adminErrosLimparController,
  feedbackController,
  erroController,
} from "../controllers/admin.controller";
import {
  suiteClientesController,
  suiteCriarController,
  suiteOrigensController,
  suitePreviewController,
  suiteSetoresController,
  suiteTiposController,
  suiteUsuariosController,
} from "../controllers/suite360.controller";
import {
  gmailCriarController,
  gmailEmailsController,
  gmailOAuthCallbackController,
  gmailOAuthDoneController,
  gmailOAuthStartController,
  gmailPreviewController,
} from "../controllers/gmail.controller";
import {
  gravacaoCriarController,
  gravacaoPreviewController,
} from "../controllers/gravacao.controller";
import {
  chatCriarController,
  chatMessagesController,
  chatPreviewController,
  chatSpacesController,
  chatStatusController,
} from "../controllers/chat.controller";
import { uploadAudioMiddleware } from "../middlewares/upload";
import { appAuth } from "../middlewares/appAuth";
import { asyncHandler } from "../utils/http";
import { runWithSuiteEnv } from "../lib/suiteEnv";

export const apiRouter = Router();

// Autenticacao por token do app (dormante ate API_AUTH_TOKEN ser definido).
apiRouter.use(appAuth);

// Ambiente do Suite por requisicao: header `x-suite-env: dev` roteia as chamadas
// ao Suite360 para o ambiente de desenvolvimento (SuiteWeb DEV). So afeta o
// Suite; transcricao, resumo e Gmail seguem iguais.
apiRouter.use((req, _res, next) => {
  const dev = String(req.headers["x-suite-env"] || "").toLowerCase() === "dev";
  runWithSuiteEnv(dev, next);
});

apiRouter.get("/health", healthController);
apiRouter.post("/transcricao", asyncHandler(transcricaoController));
apiRouter.post("/resumo", asyncHandler(resumoController));
apiRouter.post("/processar", asyncHandler(processarController));
apiRouter.post(
  "/processar-upload",
  uploadAudioMiddleware,
  asyncHandler(processarUploadController),
);
apiRouter.post(
  "/processar_upload",
  uploadAudioMiddleware,
  asyncHandler(processarUploadController),
);

// --- Integracao GoTo ---
apiRouter.get("/goto/oauth/start", asyncHandler(gotoOAuthStartController));
apiRouter.get("/goto/oauth/callback", asyncHandler(gotoOAuthCallbackController));
apiRouter.post("/goto/setup/:token", asyncHandler(gotoSetupController));
apiRouter.post("/goto/webhook/:token", asyncHandler(gotoWebhookController));
apiRouter.get("/goto/eventos", asyncHandler(gotoEventosController));
apiRouter.get("/goto/historico", asyncHandler(gotoHistoricoController));
apiRouter.get("/goto/gravacao", asyncHandler(gotoGravacaoController));
apiRouter.get("/goto/ably-token", asyncHandler(gotoAblyTokenController));
apiRouter.post("/goto/chamado", asyncHandler(gotoChamadoController));

// --- Integracao Suite360/SuiteWeb (criacao de chamados com revisao) ---
apiRouter.post("/goto/chamado/preview", asyncHandler(suitePreviewController));
apiRouter.post("/goto/chamado/criar", asyncHandler(suiteCriarController));
apiRouter.get("/suite360/clientes", asyncHandler(suiteClientesController));
apiRouter.get("/suite360/tipos", asyncHandler(suiteTiposController));
apiRouter.get("/suite360/setores", asyncHandler(suiteSetoresController));
apiRouter.get("/suite360/origens", asyncHandler(suiteOrigensController));
apiRouter.get("/suite360/usuarios", asyncHandler(suiteUsuariosController));

// --- Integracao Gmail (chamados a partir de e-mails) ---
apiRouter.get("/gmail/oauth/start", asyncHandler(gmailOAuthStartController));
apiRouter.get("/gmail/oauth/callback", asyncHandler(gmailOAuthCallbackController));
apiRouter.get("/gmail/oauth/done", asyncHandler(gmailOAuthDoneController));
apiRouter.get("/gmail/emails", asyncHandler(gmailEmailsController));
apiRouter.post("/gmail/chamado/preview", asyncHandler(gmailPreviewController));
apiRouter.post("/gmail/chamado/criar", asyncHandler(gmailCriarController));

// --- Integracao Google Chat (chamados a partir de conversas do Chat) ---
// Usa o MESMO OAuth do Gmail (a conta Google e a mesma); o que muda sao os
// escopos de Chat, pedidos no mesmo consentimento.
apiRouter.get("/chat/status", asyncHandler(chatStatusController));
apiRouter.get("/chat/spaces", asyncHandler(chatSpacesController));
apiRouter.get("/chat/messages", asyncHandler(chatMessagesController));
apiRouter.post("/chat/chamado/preview", asyncHandler(chatPreviewController));
apiRouter.post("/chat/chamado/criar", asyncHandler(chatCriarController));

// --- Chamado a partir de uma GRAVACAO avulsa (aba Gravar & Resumir) ---
// O preview recebe o audio, entao passa pelo mesmo middleware de upload do
// /processar-upload. O criar e JSON comum.
apiRouter.post(
  "/gravacao/chamado/preview",
  uploadAudioMiddleware,
  asyncHandler(gravacaoPreviewController),
);
apiRouter.post("/gravacao/chamado/criar", asyncHandler(gravacaoCriarController));

// --- Painel admin de custos de IA ---
apiRouter.get("/admin", adminPageController);
apiRouter.get("/admin/uso", asyncHandler(adminUsoController));
apiRouter.get("/admin/feedback", asyncHandler(adminFeedbackController));
apiRouter.get("/admin/erros", asyncHandler(adminErrosController));
apiRouter.post("/admin/erros/limpar", asyncHandler(adminErrosLimparController));

// Feedback do resumo da IA (enviado pelo app; passa pelo x-app-token normal).
apiRouter.post("/feedback", asyncHandler(feedbackController));
// Erro do app desktop (telemetria; mesmo caminho de auth do feedback).
apiRouter.post("/erros", asyncHandler(erroController));
