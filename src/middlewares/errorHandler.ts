import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError, getErrorMessage, isRecord } from "../lib/errors";

function normalizeHttpError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  // Erros de upload (multer).
  if (
    error instanceof Error &&
    (error.name === "MulterError" || error instanceof multer.MulterError)
  ) {
    const multerError = error as multer.MulterError;

    if (multerError.code === "LIMIT_FILE_SIZE") {
      return new AppError({
        statusCode: 413,
        code: "UPLOAD_TOO_LARGE",
        message: "Arquivo enviado excede o tamanho maximo permitido.",
      });
    }

    return new AppError({
      statusCode: 400,
      code: "UPLOAD_ERROR",
      message: "Falha ao processar upload do arquivo.",
      details: { code: multerError.code, cause: multerError.message },
    });
  }

  // Erro de JSON invalido enviado no body.
  if (isRecord(error) && error.type === "entity.parse.failed") {
    return new AppError({
      statusCode: 400,
      code: "INVALID_JSON",
      message: "JSON invalido no corpo da requisicao.",
      details: { cause: getErrorMessage(error) },
    });
  }

  // Body maior que o limite configurado no express.json.
  if (isRecord(error) && error.type === "entity.too.large") {
    return new AppError({
      statusCode: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "Body excede o limite permitido.",
    });
  }

  return new AppError({
    statusCode: 500,
    code: "INTERNAL_SERVER_ERROR",
    message: "Erro interno no servidor.",
    details: { cause: getErrorMessage(error) },
  });
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  const appError = normalizeHttpError(error);

  if (appError.statusCode >= 500) {
    console.error("[http] internal error", appError);
  }

  res.status(appError.statusCode).json({
    ok: false,
    error: {
      code: appError.code,
      message: appError.message,
      details: appError.details,
    },
  });
}
