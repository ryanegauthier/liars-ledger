// server/vitest.unit.config.js
// Offline unit tests only (test/unit/): no real server, Redis, or provider
// calls. Run with: npm run test:unit
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.js"],
    testTimeout: 10000,
  },
});
