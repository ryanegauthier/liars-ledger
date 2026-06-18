// server/vitest.config.js
// Default config — runs everything in test/free/ only.
// Run the cost suite explicitly with vitest.cost.config.js (see package.json).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/free/**/*.test.js"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
