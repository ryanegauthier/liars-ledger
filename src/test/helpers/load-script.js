// Load extension scripts (global functions) in Node for unit tests.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");

/**
 * @param {string | string[]} relativePathOrPaths - e.g. "src/keywords.js", or
 *   ["src/topic-match.js", "src/api.js"] to load multiple scripts into the
 *   same sandbox in order, matching real importScripts load order for
 *   files that depend on globals defined by an earlier one.
 * @param {Record<string, unknown>} [extraGlobals]
 */
export function loadScript(relativePathOrPaths, extraGlobals = {}) {
  const paths = Array.isArray(relativePathOrPaths) ? relativePathOrPaths : [relativePathOrPaths];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    ...extraGlobals,
  };
  for (const relativePath of paths) {
    const filePath = path.join(ROOT, relativePath);
    const code = fs.readFileSync(filePath, "utf8");
    vm.runInNewContext(code, sandbox, { filename: filePath });
  }
  return sandbox;
}

export { ROOT };
