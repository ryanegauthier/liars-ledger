// Liar's Ledger - background.js changes for v0.8.0
// Apply these two changes to your existing background.js

// ── CHANGE 1: importScripts ────────────────────────────────────────────────
// Add src/llm.js to the importScripts list.
// ORDER MATTERS: llm.js must come after ollama-parse.js (it uses buildArticleAnalysisPrompt
// if LLM_PROVIDER is "ollama"), and before background logic runs.

importScripts(
  "src/config.js",
  "src/logger.js",
  "src/lookup.js",
  "src/keywords.js",
  "src/ollama-parse.js",
  "src/ollama.js",
  "src/llm.js",          // ← ADD THIS LINE
  "src/topic-match.js",
  "src/api.js",
  "src/claimExtractor.js"
);

// ── CHANGE 2: handleAnalyze — replace the Ollama call block ───────────────
// Find this section in handleAnalyze (around line 60-85):
//
//   if (ollamaOn) {
//     logger.info("background", `Ollama article analysis: ...`);
//     const ann = await extractArticleAnalysisViaOllama(articleText, {
//       baseUrl: ollamaUrl,
//       model: ollamaModel,
//       timeoutMs: CONFIG.OLLAMA_TIMEOUT_MS || 90000,
//     });
//     if (ann.ok) { ... }
//     else { logger.warn(...) }
//   }
//
// Replace the entire if (ollamaOn) block with this:

  const llmProvider = (typeof CONFIG !== "undefined" && CONFIG.LLM_PROVIDER) || "ollama";
  const llmOn = llmProvider === "ollama"
    ? !!(CONFIG.OLLAMA_BASE_URL && CONFIG.OLLAMA_MODEL && articleText?.trim())
    : !!(articleText?.trim());

  if (llmOn) {
    logger.info("background", `LLM analysis: provider=${llmProvider}`);

    const ann = await extractArticleAnalysis(articleText, {
      provider:   llmProvider,
      // Claude options
      apiKey:     CONFIG.CLAUDE_API_KEY,
      endpoint:   CONFIG.CLAUDE_API_ENDPOINT || undefined,
      // Mistral options (extractArticleAnalysis passes full options to each provider)
      // mistralApiKey picked up inside llm.js via CONFIG.MISTRAL_API_KEY
      // Ollama options (only used when provider === "ollama")
      baseUrl:    CONFIG.OLLAMA_BASE_URL,
      model:      CONFIG.OLLAMA_MODEL,
      timeoutMs:  CONFIG.LLM_TIMEOUT_MS || 30000,
    });

    if (ann.ok) {
      articleSummary   = ann.summary || null;
      ollamaFigures    = ann.figures || [];
      mainTopicsGlobal = ann.main_topics || [];

      if (ann._meta) {
        logger.info("background", `LLM ok — provider=${ann._meta.provider}, figures=${ollamaFigures.length}, topics=${mainTopicsGlobal.length}, verified=${ann._meta.verified ?? "n/a"}, ambiguous=${ann._meta.ambiguous ?? "n/a"}`);
      } else {
        logger.info("background", `LLM ok — ${ollamaFigures.length} figure(s), ${mainTopicsGlobal.length} topic(s)`);
      }
    } else {
      logger.warn("background", `LLM analysis failed (${ann.error})`);
    }
  }

// ── CHANGE 3: manifest.json — add host_permissions for dev ─────────────────
// Add to host_permissions array in manifest.json (remove when proxy is live):
//
//   "https://api.anthropic.com/*",
//   "https://api.mistral.ai/*"
//
// Full host_permissions should look like:
//   "host_permissions": [
//     "https://api.congress.gov/*",
//     "https://api.anthropic.com/*",
//     "https://api.mistral.ai/*",
//     "http://100.67.253.3:11434/*"   ← keep for Ollama fallback, remove in prod
//   ]

// ── CHANGE 4: config.js — add the new keys ─────────────────────────────────
// Add to your existing config.js (copy from config.example.js):
//
//   LLM_PROVIDER:         "dual",
//   CLAUDE_API_KEY:       "sk-ant-...",
//   CLAUDE_API_ENDPOINT:  null,
//   MISTRAL_API_KEY:      "...",
//   MISTRAL_API_ENDPOINT: null,
//   LLM_TIMEOUT_MS:       30000,
