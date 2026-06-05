import jwt, { type SignOptions } from "jsonwebtoken";
import { createHash, randomBytes } from "node:crypto";
import { env } from "@/config/env";

type JwtTimes = { iat?: number; exp?: number };

export type AccessTokenPayload = JwtTimes & {
  sub: string; // userId
  email: string;
  typ: "access";
};

export type RefreshTokenPayload = JwtTimes & {
  sub: string;
  jti: string; // unique id; stored hashed in DB for revocation
  typ: "refresh";
};

const ACCESS_OPTS: SignOptions = { expiresIn: env.JWT_ACCESS_TTL as SignOptions["expiresIn"] };
const REFRESH_OPTS: SignOptions = { expiresIn: env.JWT_REFRESH_TTL as SignOptions["expiresIn"] };

export function signAccessToken(payload: Omit<AccessTokenPayload, "typ">): string {
  return jwt.sign({ ...payload, typ: "access" }, env.JWT_SECRET, ACCESS_OPTS);
}

export function signRefreshToken(payload: Omit<RefreshTokenPayload, "typ" | "jti">): {
  token: string;
  jti: string;
} {
  const jti = randomBytes(16).toString("hex");
  const token = jwt.sign(
    { ...payload, jti, typ: "refresh" },
    env.JWT_SECRET,
    REFRESH_OPTS,
  );
  return { token, jti };
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
  if (decoded.typ !== "access") {
    throw new jwt.JsonWebTokenError("Invalid token type");
  }
  return decoded;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET) as RefreshTokenPayload;
  if (decoded.typ !== "refresh") {
    throw new jwt.JsonWebTokenError("Invalid token type");
  }
  return decoded;
}

/** SHA-256 of the refresh token JTI — what we store in the DB for revocation. */
export function hashJti(jti: string): string {
  return createHash("sha256").update(jti).digest("hex");
}
