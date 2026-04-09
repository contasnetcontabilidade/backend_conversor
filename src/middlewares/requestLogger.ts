import { NextFunction, Request, Response } from "express";

// Log simples de cada requisição para ajudar no debug.
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const startedAt = Date.now();

  res.on("finish", () => {
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[http] ${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${elapsedMs}ms`,
    );
  });

  next();
}
