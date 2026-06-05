import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "@/config/env";
import { logger } from "@/lib/logger";
import { apiRouter } from "@/routes";
import { errorHandler, notFoundHandler } from "@/middleware/error-handler";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow same-origin / curl (no Origin header) and explicitly whitelisted ones.
        if (!origin || env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        return cb(new Error("CORS: origin not allowed"));
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(pinoHttp({ logger, customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  } }));

  app.use("/api/v1", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
