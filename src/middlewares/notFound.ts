import { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors";

// Middleware executado quando nenhuma rota foi encontrada.
export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(
    new AppError({
      statusCode: 404,
      code: "ROUTE_NOT_FOUND",
      message: `Rota nao encontrada: ${req.method} ${req.originalUrl}`,
      details: {
        hint:
          "Use /processar-upload, /processar_upload, /api/processar-upload ou /api/processar_upload.",
      },
    }),
  );
}
