import pino from "pino";
import { env } from "@/config/env";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "slicesplit-backend" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'req.body.password',
      'req.body.refreshToken',
      "*.passwordHash",
      "*.tokenHash",
    ],
    censor: "[REDACTED]",
  },
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, singleLine: false } }
      : undefined,
});
