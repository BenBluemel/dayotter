import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@dayotter/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@dayotter/db": fileURLToPath(new URL("../../packages/db/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
