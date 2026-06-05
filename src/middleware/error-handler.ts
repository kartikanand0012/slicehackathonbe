import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { JsonWebTokenError, TokenExpiredError } from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import { HttpError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` },
  });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    });
    return;
  }

  if (err instanceof TokenExpiredError) {
    res.status(401).json({
      error: { code: "TOKEN_EXPIRED", message: "Token has expired" },
    });
    return;
  }
  if (err instanceof JsonWebTokenError) {
    res.status(401).json({
      error: { code: "INVALID_TOKEN", message: "Invalid token" },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      res.status(409).json({
        error: {
          code: "UNIQUE_CONSTRAINT",
          message: "Resource already exists",
          details: { target: err.meta?.target },
        },
      });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: "Resource not found" },
      });
      return;
    }
  }

  logger.error({ err }, "Unhandled error");
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Internal server error" },
  });
};
