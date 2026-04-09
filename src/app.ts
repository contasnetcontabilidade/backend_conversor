import express from "express";
import { errorHandler } from "./middlewares/errorHandler";
import { notFoundHandler } from "./middlewares/notFound";
import { requestLogger } from "./middlewares/requestLogger";
import { apiRouter } from "./routes/api.routes";

export const app = express();

app.disable("x-powered-by");

// Allow cross-origin requests from any origin (including preflight checks).
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization",
  );

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

app.use(express.json({ limit: "5mb" }));
app.use(requestLogger);

// Main API routes.
app.use(apiRouter);
app.use("/api", apiRouter);

// Keep these at the end.
app.use(notFoundHandler);
app.use(errorHandler);
