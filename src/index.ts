import "dotenv/config";
import type { Server } from "http";
import { startHttpServer } from "./server";

const configuredPort = Number(process.env.PORT ?? "3000");
let serverRef: Server | null = null;

async function bootstrap() {
  const { server, port } = await startHttpServer({
    port: configuredPort,
    host: "0.0.0.0",
  });
  serverRef = server;

  console.log(`[http] Microservico online em http://localhost:${port}`);
  console.log(
    "[http] Endpoints: /health, /processar-upload, /processar_upload, /api/processar-upload, /api/processar_upload, /demo",
  );
}

bootstrap().catch((error) => {
  console.error("[http] Falha ao iniciar servidor", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[process] uncaughtException", error);

  if (!serverRef) {
    process.exit(1);
    return;
  }

  serverRef.close(() => process.exit(1));
});

