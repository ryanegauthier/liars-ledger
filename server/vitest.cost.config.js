// server/vitest.cost.config.js
// Runs ONLY the test/cost/ suite — real LLM API calls, real (small) cost.
// Invoked explicitly via `npm run test:cost`, never by default.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/cost/**/*.test.js"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
