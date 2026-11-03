// server/vitest.config.js
// Default config - runs test/free/ (against a real server) and test/unit/
// (offline). Run only the offline tests with: npm run test:unit
// Run the cost suite explicitly with vitest.cost.config.js (see package.json).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/free/**/*.test.js", "test/unit/**/*.test.js"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
