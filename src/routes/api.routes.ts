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
  gotoOAuthCallbackController,
  gotoOAuthStartController,
  gotoSetupController,
  gotoWebhookController,
} from "../controllers/goto.controller";
import {
  adminPageController,
  adminUsoController,
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
import { uploadAudioMiddleware } from "../middlewares/upload";
import { asyncHandler } from "../utils/http";

export const apiRouter = Router();

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

// --- Painel admin de custos de IA ---
apiRouter.get("/admin", adminPageController);
apiRouter.get("/admin/uso", asyncHandler(adminUsoController));
