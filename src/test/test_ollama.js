/**
 * Optional integration test — requires a running Ollama server.
 *
 *   npm run test:integration:ollama
 *
 * Env:
 *   OLLAMA_HOST  (default http://127.0.0.1:11434)
 *   OLLAMA_MODEL (default llama3.2:3b)
 */

import { loadScript, ROOT } from "./helpers/load-script.js";

const OLLAMA_BASE = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";

loadScript("src/ollama-parse.js");
const ollama = loadScript("src/ollama.js", { fetch });
const { extractArticleAnalysisViaOllama } = ollama;

const TEST_ARTICLES = [
  {
    label: "Healthcare — clear claims",
    text: `Senator Bernie Sanders announced Monday he will reintroduce his Medicare for All
legislation, arguing the U.S. spends more on healthcare than any developed nation while
leaving millions uninsured. The bill would eliminate private insurance and create a
single government-run program. Senator Mitch McConnell criticized the proposal as a
socialist takeover that would cost trillions. Representative Alexandria Ocasio-Cortez
called it the most important piece of legislation in a generation.`,
  },
  {
    label: "Gun control — multiple figures",
    text: `The House Judiciary Committee advanced a bill Wednesday requiring universal background
checks for all firearm purchases. Representative Jerry Nadler, the committee chair, said
the measure was long overdue. Representative Jim Jordan voted against it, calling the bill
an unconstitutional attack on Second Amendment rights. Senator Chris Murphy has pledged
to push companion legislation in the Senate.`,
  },
];

async function runTest(label, articleText) {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`TEST: ${label}`);
  console.log("═".repeat(64));

  const start = Date.now();
  const result = await extractArticleAnalysisViaOllama(articleText, {
    baseUrl: OLLAMA_BASE,
    model: MODEL,
    timeoutMs: 120000,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (!result.ok) {
    console.error(`FAILED (${elapsed}s): ${result.error}`);
    return false;
  }

  console.log(`OK — ${elapsed}s\n`);
  console.log(`SUMMARY:\n  ${result.summary}\n`);
  console.log(`MAIN TOPICS: ${result.main_topics.join(", ")}\n`);
  console.log(`FIGURES (${result.figures.length}):`);
  for (const fig of result.figures) {
    console.log(`  • ${fig.lookup_name}`);
    console.log(`    claim: ${fig.claim ?? "(none)"}`);
    console.log(`    search_terms: ${fig.search_terms.join(", ")}`);
  }

  const issues = [];
  if (!result.summary) issues.push("Empty summary");
  if (result.main_topics.length === 0) issues.push("No main_topics returned");
  for (const fig of result.figures) {
    if (!fig.lookup_name) issues.push("Figure missing lookup_name");
    if (fig.search_terms.length === 0) issues.push(`${fig.lookup_name}: no search_terms`);
    const surname = fig.lookup_name.split(" ").pop().toLowerCase();
    if (fig.search_terms.some((t) => t.toLowerCase().includes(surname))) {
      issues.push(`${fig.lookup_name}: name leaked into search_terms`);
    }
  }

  if (issues.length) {
    console.log("\nIssues:");
    issues.forEach((i) => console.log(`   - ${i}`));
    return false;
  }
  console.log("\nAll checks passed");
  return true;
}

async function main() {
  console.log("Liars Ledger — Ollama integration test");
  console.log(`Root:     ${ROOT}`);
  console.log(`Endpoint: ${OLLAMA_BASE}`);
  console.log(`Model:    ${MODEL}`);

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    console.log(`Connected. Models: ${models.join(", ") || "(none)"}`);
    const base = MODEL.split(":")[0];
    if (!models.some((m) => m.startsWith(base))) {
      console.warn(`Warning: "${MODEL}" may not be pulled. Try: ollama pull ${MODEL}`);
    }
  } catch (e) {
    console.error(`Cannot reach Ollama: ${e.message}`);
    process.exit(1);
  }

  let passed = 0;
  for (const tc of TEST_ARTICLES) {
    if (await runTest(tc.label, tc.text)) passed++;
  }

  console.log(`\n${passed}/${TEST_ARTICLES.length} scenarios passed`);
  process.exit(passed === TEST_ARTICLES.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
