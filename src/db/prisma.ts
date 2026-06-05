import { PrismaClient } from "@prisma/client";
import { env } from "@/config/env";

/**
 * Prisma client singleton. In dev (hot reload) we attach it to globalThis to
 * avoid exhausting the connection pool. In prod we just construct once.
 */
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__prisma ??
  new PrismaClient({
    log:
      env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

if (env.NODE_ENV !== "production") {
  globalForPrisma.__prisma = prisma;
}
