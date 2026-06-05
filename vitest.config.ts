import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    env: {
      NODE_ENV: "test",
      PORT: "4001",
      DATABASE_URL: "postgresql://test:test@localhost:5432/slicesplit_test",
      JWT_SECRET: "test-secret-must-be-at-least-32-characters-long-yes-it-is",
      CORS_ORIGINS: "http://localhost:3000",
      LOG_LEVEL: "silent",
    },
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: ["node_modules/", "dist/", "prisma/", "**/*.test.ts"],
    },
  },
  css: {
    postcss: { plugins: [] },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
