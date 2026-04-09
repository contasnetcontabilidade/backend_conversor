import { AppError, isRecord } from "../lib/errors";

// Garante que o body recebido seja um objeto JSON.
export function ensureBodyObject(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new AppError({
      statusCode: 400,
      code: "INVALID_BODY",
      message: "Body da requisicao deve ser um objeto JSON.",
    });
  }

  return body;
}

// Lê uma string opcional e valida se não veio vazia.
export function getOptionalString(body: Record<string, unknown>, field: string) {
  const value = body[field];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError({
      statusCode: 400,
      code: "INVALID_FIELD",
      message: `Campo ${field} deve ser string nao vazia.`,
    });
  }

  return value.trim();
}

// Lê um boolean opcional.
export function getOptionalBoolean(body: Record<string, unknown>, field: string) {
  const value = body[field];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new AppError({
      statusCode: 400,
      code: "INVALID_FIELD",
      message: `Campo ${field} deve ser boolean.`,
    });
  }

  return value;
}
