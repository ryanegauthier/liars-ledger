// scripts/build-release.js
// Builds the Chrome Web Store package: build/liars-ledger-v{version}.zip
// Run from the project root: node scripts/build-release.js
//
// The file list is read from what the extension actually loads, so it cannot
// drift out of sync again (the previous hand-maintained list had):
//   - manifest.json: service worker, content scripts, popup, icons
//   - background.js importScripts(...)
//   - <script src> tags in popup.html and report.html
//   - src/data/politicians.json (fetched at runtime by src/lookup.js)
// src/config.js is built from the committed src/config.example.js, never
// from the local (gitignored) src/config.js, which may hold dev API keys.
//
// The build fails instead of packaging if a referenced file is missing, if
// the packaged config contains an API key or does not point at the
// production proxy, or if any TEMP DEBUG / [LL DEBUG] code remains.
//
// The zip has manifest.json at its root, as the Web Store requires.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const version  = manifest.version;
const buildDir = `build/liars-ledger-v${version}`;
const zipPath  = `build/liars-ledger-v${version}.zip`;

function fail(msg) {
  console.error(`\nBUILD FAILED: ${msg}`);
  process.exit(1);
}

// --- Collect every file the extension loads ---
const files = new Set(["manifest.json"]);
files.add(manifest.background.service_worker);
for (const cs of manifest.content_scripts || []) for (const f of cs.js || []) files.add(f);
files.add(manifest.action.default_popup);
for (const f of Object.values(manifest.icons || {})) files.add(f);
for (const f of Object.values(manifest.action.default_icon || {})) files.add(f);

const background = readFileSync(manifest.background.service_worker, "utf8");
const importBlock = background.match(/importScripts\(([\s\S]*?)\);/);
if (!importBlock) fail("could not find importScripts(...) in the service worker");
for (const m of importBlock[1].matchAll(/["']([^"']+)["']/g)) files.add(m[1]);

for (const page of ["popup.html", "report.html"]) {
  files.add(page);
  for (const m of readFileSync(page, "utf8").matchAll(/<script[^>]+src=["']([^"']+)["']/g)) files.add(m[1]);
}
files.add("src/data/politicians.json");

// --- Copy into the build folder ---
if (existsSync(buildDir)) rmSync(buildDir, { recursive: true });
if (existsSync(zipPath)) rmSync(zipPath);
for (const f of [...files].sort()) {
  const source = f === "src/config.js" ? "src/config.example.js" : f;
  if (!existsSync(source)) fail(`referenced file is missing: ${source}`);
  mkdirSync(dirname(join(buildDir, f)), { recursive: true });
  copyFileSync(source, join(buildDir, f));
}
console.log(`Liar's Ledger v${version}: ${files.size} files`);

// --- Safety checks on the packaged copy ---
const sandbox = {};
vm.runInNewContext(`${readFileSync(join(buildDir, "src/config.js"), "utf8")}\nthis.CONFIG = CONFIG;`, sandbox);
const config = sandbox.CONFIG;
for (const [k, v] of Object.entries(config)) {
  if (/KEY|SECRET|TOKEN/i.test(k) && v) fail(`packaged config has a value for ${k}`);
}
if (config.PROXY_URL !== "https://api.liarsledger.com") fail(`packaged PROXY_URL is ${config.PROXY_URL}`);
for (const f of files) {
  if (!/\.(js|html)$/.test(f)) continue;
  if (/TEMP DEBUG|\[LL DEBUG\]/.test(readFileSync(join(buildDir, f), "utf8"))) fail(`debug code left in ${f}`);
}
console.log("  config: production proxy, no API keys");
console.log("  no TEMP DEBUG code");

// --- Zip with manifest.json at the root ---
// tar ships with Windows 10+ and macOS; -a picks zip from the extension and
// writes forward-slash paths (Windows PowerShell 5's Compress-Archive does not).
execFileSync("tar", ["-a", "-c", "-f", `../${zipPath.split("/").pop()}`, ...[...files].sort()], { cwd: buildDir, stdio: "inherit" });
const listing = execFileSync("tar", ["-t", "-f", zipPath], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
if (!listing.includes("manifest.json")) fail("manifest.json is not at the root of the zip");
console.log(`\nBuilt ${zipPath} (${(statSync(zipPath).size / 1024).toFixed(0)} KB, ${listing.length} entries)`);
