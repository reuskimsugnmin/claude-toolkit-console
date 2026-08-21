import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "packages/*/test/type-tests/**"],
  },
  resolve: {
    alias: {
      "@ctk/core": path.resolve(root, "packages/core/src/index.ts"),
      "@ctk/probe": path.resolve(root, "packages/probe/src/index.ts"),
      "@ctk/actuator": path.resolve(root, "packages/actuator/src/index.ts"),
      "@ctk/sync": path.resolve(root, "packages/sync/src/index.ts"),
      "@ctk/gen": path.resolve(root, "packages/gen/src/index.ts"),
    },
  },
});
