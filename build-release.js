// build-release.js
// Creates a distributable zip of the extension for sharing.
// Run from the project root: node build-release.js
//
// Output: liars-ledger-v{version}.zip
// Contains everything needed to load the extension in Chrome dev mode.
// Does NOT include config.js (has API keys), server/, or node_modules.

import { execSync } from "child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

// Read version from manifest
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const version  = manifest.version;
const zipName  = `liars-ledger-v${version}.zip`;
const buildDir = `build/liars-ledger-v${version}`;

console.log(`Building Liar's Ledger v${version}...`);

// Clean and recreate build dir
if (existsSync("build")) rmSync("build", { recursive: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(`${buildDir}/src/data`, { recursive: true });
mkdirSync(`${buildDir}/icons`, { recursive: true });

// Files to include
// NOTE: rootFiles and srcFiles must stay in sync with background.js importScripts
const rootFiles = [
  "manifest.json",
  "background.js",
  "content.js",
  "popup.html",
  "popup.js",
  "report.html",
  "report.js",
];

const srcFiles = [
  "src/config.example.js",  // user renames to config.js
  "src/logger.js",
  "src/lookup.js",
  "src/keywords.js",
  "src/llm.js",
  "src/topic-match.js",
  "src/api.js",
  "src/votesmart.js",
  "src/data/politicians.json",
];

const iconFiles = [
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

// Copy files
for (const f of rootFiles) {
  if (existsSync(f)) {
    copyFileSync(f, join(buildDir, f));
  } else {
    console.warn(`  ⚠ missing: ${f}`);
  }
}

for (const f of srcFiles) {
  if (existsSync(f)) {
    copyFileSync(f, join(buildDir, f));
  } else {
    console.warn(`  ⚠ missing: ${f}`);
  }
}

for (const f of iconFiles) {
  if (existsSync(f)) {
    copyFileSync(f, join(buildDir, f));
  } else {
    console.warn(`  ⚠ missing icon: ${f}`);
  }
}

// Write a setup README into the zip
const setupReadme = `# Liar's Ledger — Setup

## Step 1 — Rename the config file

Open the \`src\` folder and rename \`config.example.js\` to \`config.js\`.

That's it. No API keys needed — everything runs through api.liarsledger.com.

## Step 2 — Load the extension

1. Open Chrome and go to \`chrome://extensions\`
2. Turn on **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select this folder
5. The Liar's Ledger icon will appear in your toolbar

## Step 3 — Use it

Navigate to any political news article, click the Liar's Ledger icon, and hit **Scan This Page**.

---

Questions? https://github.com/ryanegauthier/liars-ledger
`;

writeFileSync(join(buildDir, "SETUP.md"), setupReadme);
console.log("  ✓ SETUP.md written");

// Create zip
try {
  execSync(`zip -r ${zipName} build/liars-ledger-v${version}/`, { stdio: "inherit" });
  console.log(`\n✅ Built: ${zipName}`);
} catch (e) {
  // Windows fallback
  try {
    execSync(
      `powershell Compress-Archive -Path "build/liars-ledger-v${version}" -DestinationPath "${zipName}" -Force`,
      { stdio: "inherit" }
    );
    console.log(`\n✅ Built: ${zipName}`);
  } catch (e2) {
    console.error("Could not create zip.");
    console.log(`Build folder ready at: build/liars-ledger-v${version}`);
  }
}