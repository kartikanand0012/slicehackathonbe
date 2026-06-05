import type { RequestHandler } from "express";
import { verifyAccessToken } from "@/lib/jwt";
import { UnauthorizedError } from "@/lib/errors";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string };
    }
  }
}

/**
 * Extract & verify the Bearer access token. Populates req.user.
 * Throws UnauthorizedError on missing/invalid token.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or malformed Authorization header");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new UnauthorizedError("Empty token");

  const payload = verifyAccessToken(token);
  req.user = { id: payload.sub, email: payload.email };
  next();
};
