import { Router } from "express";
import {
  healthController,
  processarUploadController,
  processarController,
  resumoController,
  transcricaoController,
} from "../controllers/api.controller";
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
