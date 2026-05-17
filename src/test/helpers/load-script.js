// Load extension scripts (global functions) in Node for unit tests.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");

/**
 * @param {string} relativePath - e.g. "src/keywords.js"
 * @param {Record<string, unknown>} [extraGlobals]
 */
export function loadScript(relativePath, extraGlobals = {}) {
  const filePath = path.join(ROOT, relativePath);
  const code = fs.readFileSync(filePath, "utf8");
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    ...extraGlobals,
  };
  vm.runInNewContext(code, sandbox, { filename: filePath });
  return sandbox;
}

export { ROOT };
