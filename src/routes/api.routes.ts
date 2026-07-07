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
