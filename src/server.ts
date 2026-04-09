import type { Server } from "http";
import { app } from "./app";

export type StartHttpServerOptions = {
  port: number;
  host?: string;
  fallbackToEphemeralPort?: boolean;
};

export type StartedHttpServer = {
  server: Server;
  port: number;
  host: string;
};

function assertValidPort(port: number) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT invalida: ${port}`);
  }
}

function listen(port: number, host: string): Promise<StartedHttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const resolvedPort =
        typeof address === "object" && address ? address.port : port;
      resolve({ server, port: resolvedPort, host });
    });

    server.once("error", reject);
  });
}

export async function startHttpServer(
  options: StartHttpServerOptions,
): Promise<StartedHttpServer> {
  const host = options.host ?? "127.0.0.1";
  assertValidPort(options.port);

  try {
    return await listen(options.port, host);
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException | undefined;
    if (
      options.fallbackToEphemeralPort &&
      maybeError?.code === "EADDRINUSE"
    ) {
      return listen(0, host);
    }

    throw error;
  }
}

