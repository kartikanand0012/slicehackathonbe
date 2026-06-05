import type { RequestHandler } from "express";
import type { ZodTypeAny, z } from "zod";

/**
 * Validate `req.body` against a Zod schema and replace it with the parsed
 * result. Wrap your controllers so they can trust `req.body` is well-formed.
 */
export const validateBody =
  <S extends ZodTypeAny>(schema: S): RequestHandler =>
  (req, _res, next) => {
    req.body = schema.parse(req.body) as z.infer<S>;
    next();
  };

export const validateQuery =
  <S extends ZodTypeAny>(schema: S): RequestHandler =>
  (req, _res, next) => {
    // Express types req.query as ParsedQs; we trust the schema to narrow it.
    (req as unknown as { query: z.infer<S> }).query = schema.parse(req.query);
    next();
  };

export const validateParams =
  <S extends ZodTypeAny>(schema: S): RequestHandler =>
  (req, _res, next) => {
    (req as unknown as { params: z.infer<S> }).params = schema.parse(req.params);
    next();
  };

/**
 * Wrap an async controller so thrown errors hit the error middleware. Avoids
 * scattering try/catch through controllers.
 */
export const asyncHandler =
  <T extends RequestHandler>(fn: T): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
