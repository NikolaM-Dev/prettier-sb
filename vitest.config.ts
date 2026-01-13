import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/second-brain/**/*.test.ts"],
  },
});
