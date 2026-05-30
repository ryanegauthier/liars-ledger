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
const rootFiles = [
  "manifest.json",
  "background.js",
  "content.js",
  "popup.html",
  "popup.js",
];

const srcFiles = [
  "src/config.example.js",  // included as reference — user must rename to config.js
  "src/logger.js",
  "src/lookup.js",
  "src/keywords.js",
  "src/ollama-parse.js",
  "src/ollama.js",
  "src/llm.js",
  "src/topic-match.js",
  "src/api.js",
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
const setupReadme = `# Liar's Ledger v${version} — Setup Instructions

## Installation

1. Unzip this folder somewhere permanent on your computer
2. Rename \`src/config.example.js\` to \`src/config.js\`
3. Open \`src/config.js\` and fill in your API keys (see below)
4. Open Chrome and go to \`chrome://extensions\`
5. Enable **Developer mode** (toggle in the top right)
6. Click **Load unpacked**
7. Select this unzipped folder
8. Navigate to any political news article and click the Liar's Ledger icon

## API Keys Required

You need a Congress.gov API key (free, instant):
- Register at: https://api.congress.gov/sign-up/
- Paste the key into \`src/config.js\` as \`CONGRESS_API_KEY\`

The AI claim extraction uses the shared backend at api.liarsledger.com.
No additional keys needed — the backend is already configured.

## config.js

\`\`\`js
const CONFIG = {
  CONGRESS_API_KEY:     "your-key-here",
  LLM_PROVIDER:         "dual",
  CLAUDE_API_KEY:       null,
  MISTRAL_API_KEY:      null,
  CLAUDE_API_ENDPOINT:  "https://api.liarsledger.com/api/claude/extract",
  MISTRAL_API_ENDPOINT: "https://api.liarsledger.com/api/mistral/extract",
  LLM_TIMEOUT_MS:       30000,
  OLLAMA_BASE_URL:      null,
  OLLAMA_MODEL:         null,
  OLLAMA_TIMEOUT_MS:    30000,
  GOVTRACK_KEY:         null,
  VOTESMART_KEY:        null,
};
\`\`\`

## Questions?

See the full project at: https://github.com/ryanegauthier/worth-noting
`;

writeFileSync(join(buildDir, "SETUP.md"), setupReadme);
console.log("  ✓ SETUP.md written");

// Create zip
try {
  execSync(`cd build && zip -r ../${zipName} liars-ledger-v${version}/`, { stdio: "inherit" });
  console.log(`\n✅ Built: ${zipName}`);
  console.log(`\nNext steps:`);
  console.log(`  1. git tag v${version}`);
  console.log(`  2. git push origin v${version}`);
  console.log(`  3. Go to GitHub → Releases → Draft a new release`);
  console.log(`  4. Select tag v${version}, upload ${zipName}`);
} catch (e) {
  // zip not available on Windows — try PowerShell
  try {
    execSync(
      `powershell Compress-Archive -Path "build/liars-ledger-v${version}" -DestinationPath "${zipName}" -Force`,
      { stdio: "inherit" }
    );
    console.log(`\n✅ Built: ${zipName}`);
  } catch (e2) {
    console.error("Could not create zip. Install zip or run from WSL.");
    console.log(`Build folder ready at: ${buildDir}`);
    console.log("Zip it manually and upload to GitHub Releases.");
  }
}
