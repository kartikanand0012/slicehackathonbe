import { prisma } from "@/db/prisma";
import { hashPassword, verifyPassword } from "@/lib/password";
import {
  hashJti,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "@/lib/jwt";
import {
  ConflictError,
  UnauthorizedError,
} from "@/lib/errors";
import type { LoginBody, RegisterBody } from "./auth.schemas";

type AuthResult = {
  user: { id: string; email: string; name: string; phone: string | null };
  accessToken: string;
  refreshToken: string;
};

function publicUser(u: {
  id: string;
  email: string;
  name: string;
  phone: string | null;
}) {
  return { id: u.id, email: u.email, name: u.name, phone: u.phone };
}

async function issueTokens(user: { id: string; email: string }): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  const accessToken = signAccessToken({ sub: user.id, email: user.email });
  const { token: refreshToken, jti } = signRefreshToken({ sub: user.id });

  const decoded = verifyRefreshToken(refreshToken);
  const expiresAt = new Date((decoded.exp ?? 0) * 1000 || Date.now() + 30 * 86_400_000);

  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: hashJti(jti), expiresAt },
  });

  return { accessToken, refreshToken };
}

export async function register(input: RegisterBody): Promise<AuthResult> {
  const existing = await prisma.user.findFirst({
    where: {
      OR: [{ email: input.email }, ...(input.phone ? [{ phone: input.phone }] : [])],
    },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError("An account with that email or phone already exists");
  }

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      phone: input.phone ?? null,
      passwordHash,
    },
    select: { id: true, email: true, name: true, phone: true },
  });

  await prisma.auditEvent.create({
    data: { actorId: user.id, action: "USER_REGISTERED" },
  });

  const tokens = await issueTokens(user);
  return { user: publicUser(user), ...tokens };
}

export async function login(input: LoginBody): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      passwordHash: true,
    },
  });
  // Constant-ish-time fall-through: if user is missing we still hash a fake
  // string so failed logins don't leak which emails are registered. argon2
  // verify on a missing hash would early-return otherwise.
  const ok = user
    ? await verifyPassword(user.passwordHash, input.password)
    : (await verifyPassword(
        "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        input.password,
      ),
      false);

  if (!user || !ok) {
    throw new UnauthorizedError("Invalid email or password");
  }

  await prisma.auditEvent.create({
    data: { actorId: user.id, action: "USER_LOGIN" },
  });

  const tokens = await issueTokens(user);
  return { user: publicUser(user), ...tokens };
}

export async function refresh(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new UnauthorizedError("Invalid refresh token");
  }

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashJti(payload.jti) },
  });
  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw new UnauthorizedError("Refresh token revoked or expired");
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true },
  });
  if (!user) throw new UnauthorizedError("User no longer exists");

  // Rotate: revoke old, issue new
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  return issueTokens(user);
}

export async function logout(refreshToken: string): Promise<void> {
  try {
    const payload = verifyRefreshToken(refreshToken);
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashJti(payload.jti), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  } catch {
    // Idempotent: an invalid token is "already logged out".
  }
}
