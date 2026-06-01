// Liar's Ledger - src/llm.js
// Unified LLM provider module.
//
// Exports three functions with identical signatures:
//   extractArticleAnalysisViaMistral(articleText, options)
//   extractArticleAnalysisViaClaude(articleText, options)
//   extractArticleAnalysisDualVerified(articleText, options)  ← production path
//
// All return:
//   { ok: true,  summary, main_topics, figures, _meta }
//   { ok: false, error }
//
// Proxy mode (production):
//   Set CLAUDE_API_ENDPOINT / MISTRAL_API_ENDPOINT to your backend URLs.
//   The proxy accepts { articleText } and returns the parsed result directly.
//   No client-side API keys needed.
//
// Direct mode (local dev):
//   Leave endpoints at defaults, set CLAUDE_API_KEY / MISTRAL_API_KEY in config.js.

// ---------------------------------------------------------------------------
// Endpoints — override in config.js for proxy in production
// ---------------------------------------------------------------------------
const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";
const CLAUDE_API_URL  = "https://api.anthropic.com/v1/messages";

// Models — cheap tiers for dev, upgrade in prod
const MISTRAL_MODEL = "mistral-small-latest";      // ~$0.10/1M tokens in
const CLAUDE_MODEL  = "claude-haiku-4-5-20251001"; // cheapest Claude 4 tier

// ---------------------------------------------------------------------------
// Prompt — canonical version. Must match server/providers/_shared.js exactly.
// When changing this, update _shared.js too (and vice versa).
// ---------------------------------------------------------------------------
const MAX_ARTICLE_CHARS = 12000;

function buildPrompt(articleText) {
  const excerpt = articleText.trim().slice(0, MAX_ARTICLE_CHARS);
  return (
    "You analyze U.S. political news for a browser extension that queries Congress.gov.\n\n" +
    "Read the article excerpt. Then output ONLY valid JSON (no markdown) with this exact shape:\n" +
    '{"article_summary":"2-5 sentences in plain English what the piece is about politically",' +
    '"main_topics":["2-8 short noun phrases for Congress.gov bill search — policy areas only, no names"],' +
    '"figures":[' +
    '{"lookup_name":"string that can identify a current U.S. Senator or Representative — prefer \\"Sen. Lastname\\", \\"Rep. Lastname\\", \\"Senator Lastname\\", or \\"Representative Lastname\\"; use the surname as it is usually written in Congress",' +
    '"claim":"one sentence: the article\'s main policy-related assertion about this person, or null",' +
    '"search_terms":["2-6 short phrases for bill title search — never include the person\'s name"]}' +
    "]}\n\n" +
    "Rules:\n" +
    "- Only include people who are clearly discussed as federal lawmakers (current Congress). Omit the President, Vice President, Cabinet, governors, candidates not in Congress, and vague references.\n" +
    "- Include at most 10 figures. If none qualify, use an empty figures array.\n" +
    "- Use the most formal version of each person's name consistently. Never return the same person twice with different name formats (e.g. 'Sen. Sanders' and 'Sen. Bernie Sanders' are the same person — pick one).\n" +
    "- main_topics must reflect the dominant legislation/policy threads in the article.\n" +
    "- search_terms must be useful for matching bill titles (e.g. \"border security\", \"child tax credit\").\n\n" +
    "Article excerpt:\n\"\"\"\n" +
    excerpt +
    '\n"""'
  );
}

// ---------------------------------------------------------------------------
// JSON parser — used for direct API calls only.
// Proxy responses are already parsed — skip this.
// ---------------------------------------------------------------------------
function parseContent(content, providerName) {
  let raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const start = raw.indexOf("{");
  const end   = raw.lastIndexOf("}");
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, error: `${providerName} returned unparseable JSON` }; }

  const summary = typeof parsed?.article_summary === "string"
    ? parsed.article_summary.trim() : "";

  const main_topics = Array.isArray(parsed?.main_topics)
    ? parsed.main_topics.map(t => String(t).trim()).filter(Boolean) : [];

  const figures = [];
  for (const row of (Array.isArray(parsed?.figures) ? parsed.figures : [])) {
    const lookup_name = typeof row?.lookup_name === "string" ? row.lookup_name.trim() : "";
    if (!lookup_name) continue;
    const claim = row.claim === null || row.claim === undefined
      ? null : String(row.claim).trim() || null;
    const search_terms = Array.isArray(row.search_terms)
      ? row.search_terms.map(t => String(t).trim()).filter(Boolean) : [];
    figures.push({ lookup_name, claim, search_terms });
  }

  return { ok: true, summary, main_topics, figures };
}

// ---------------------------------------------------------------------------
// Fetch wrapper — uses AbortSignal.timeout (Node 18+ / modern browsers)
// ---------------------------------------------------------------------------
async function doFetch(url, init, timeoutMs) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

// ---------------------------------------------------------------------------
// Mistral
// ---------------------------------------------------------------------------
async function extractArticleAnalysisViaMistral(articleText, options) {
  const apiKey    = options.mistralApiKey || (typeof CONFIG !== "undefined" && CONFIG.MISTRAL_API_KEY);
  const timeoutMs = options.timeoutMs ?? 30000;
  const endpoint  = options.mistralEndpoint || options.endpoint || MISTRAL_API_URL;
  const isProxy   = endpoint !== MISTRAL_API_URL;

  if (!isProxy && !apiKey) return { ok: false, error: "Mistral API key not configured" };

  let res;
  try {
    res = await doFetch(
      endpoint,
      isProxy
        ? {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ articleText }),
          }
        : {
            method:  "POST",
            headers: {
              "Content-Type":  "application/json",
              "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model:       MISTRAL_MODEL,
              temperature: 0.0,
              max_tokens:  1024,
              messages:    [{ role: "user", content: buildPrompt(articleText) }],
            }),
          },
      timeoutMs,
    );
  } catch (e) {
    return {
      ok: false,
      error: e?.name === "TimeoutError" || e?.name === "AbortError"
        ? "Mistral request timed out" : e.message,
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Mistral HTTP ${res.status}: ${body.slice(0, 120)}` };
  }

  let data;
  try { data = await res.json(); }
  catch { return { ok: false, error: "Mistral returned non-JSON response" }; }

  // Proxy returns the parsed result directly
  if (isProxy) {
    if (!data?.ok) return { ok: false, error: data?.error || "Mistral proxy returned error" };
    return { ...data, _meta: { provider: "mistral", model: MISTRAL_MODEL } };
  }

  // Direct API — parse raw completion
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, error: "Mistral returned empty content" };
  }

  const result = parseContent(content, "Mistral");
  if (result.ok) result._meta = { provider: "mistral", model: MISTRAL_MODEL };
  return result;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
async function extractArticleAnalysisViaClaude(articleText, options) {
  const apiKey    = options.claudeApiKey || (typeof CONFIG !== "undefined" && CONFIG.CLAUDE_API_KEY);
  const timeoutMs = options.timeoutMs ?? 30000;
  const endpoint  = options.claudeEndpoint || options.endpoint || CLAUDE_API_URL;
  const isProxy   = endpoint !== CLAUDE_API_URL;

  if (!isProxy && !apiKey) return { ok: false, error: "Claude API key not configured" };

  let res;
  try {
    res = await doFetch(
      endpoint,
      isProxy
        ? {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ articleText }),
          }
        : {
            method:  "POST",
            headers: {
              "Content-Type":      "application/json",
              "x-api-key":         apiKey,
              "anthropic-version": "2023-06-01",
              "anthropic-dangerous-direct-browser-access": "true",
            },
            body: JSON.stringify({
              model:       CLAUDE_MODEL,
              max_tokens:  1024,
              temperature: 0.0,
              messages:    [{ role: "user", content: buildPrompt(articleText) }],
            }),
          },
      timeoutMs,
    );
  } catch (e) {
    return {
      ok: false,
      error: e?.name === "TimeoutError" || e?.name === "AbortError"
        ? "Claude request timed out" : e.message,
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Claude HTTP ${res.status}: ${body.slice(0, 120)}` };
  }

  let data;
  try { data = await res.json(); }
  catch { return { ok: false, error: "Claude returned non-JSON response" }; }

  // Proxy returns the parsed result directly
  if (isProxy) {
    if (!data?.ok) return { ok: false, error: data?.error || "Claude proxy returned error" };
    return { ...data, _meta: { provider: "claude", model: CLAUDE_MODEL } };
  }

  // Direct API — parse raw completion
  const content = data?.content?.[0]?.text;
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, error: "Claude returned empty content" };
  }

  const result = parseContent(content, "Claude");
  if (result.ok) result._meta = { provider: "claude", model: CLAUDE_MODEL };
  return result;
}

// ---------------------------------------------------------------------------
// Dual-model verification — the production architecture
//
// Both models run in parallel on the same article.
// Claims are compared per politician using Jaccard word overlap.
// Result gets a verification badge:
//   "dual_verified"  — both models agree (similarity >= threshold)
//   "single_model"   — one model failed, showing the other's result
//   "ambiguous"      — both succeeded but claims diverge
// ---------------------------------------------------------------------------

const AGREEMENT_THRESHOLD = 0.65; // Jaccard similarity floor for "verified"

function jaccardSimilarity(a, b) {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;
  const tokenize = str => new Set(
    str.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2)
  );
  const sa = tokenize(a);
  const sb = tokenize(b);
  let intersection = 0;
  for (const w of sa) { if (sb.has(w)) intersection++; }
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 1.0 : intersection / union;
}

function mergeFigures(claudeFigures, mistralFigures) {
  const mistralMap = new Map(mistralFigures.map(f => [f.lookup_name.toLowerCase(), f]));
  const merged = [];

  for (const cf of claudeFigures) {
    const mf = mistralMap.get(cf.lookup_name.toLowerCase());

    if (!mf) {
      merged.push({ ...cf, _verification: "single_model", _verified_by: "claude" });
      continue;
    }

    const similarity = jaccardSimilarity(cf.claim, mf.claim);

    if (similarity >= AGREEMENT_THRESHOLD) {
      merged.push({
        ...cf,
        // Merge search_terms from both models — more signal for Congress.gov matching
        search_terms: [...new Set([...cf.search_terms, ...mf.search_terms])].slice(0, 10),
        _verification: "dual_verified",
        _similarity: Math.round(similarity * 100),
      });
    } else {
      merged.push({
        ...cf,
        _verification: "ambiguous",
        _claude_claim:  cf.claim,
        _mistral_claim: mf.claim,
        _similarity: Math.round(similarity * 100),
        // Use null claim so sidebar doesn't display an unverified claim
        claim: null,
      });
    }
  }

  // Add any figures Mistral found that Claude missed
  for (const mf of mistralFigures) {
    const alreadyMerged = merged.some(f => f.lookup_name.toLowerCase() === mf.lookup_name.toLowerCase());
    if (!alreadyMerged) {
      merged.push({ ...mf, _verification: "single_model", _verified_by: "mistral" });
    }
  }

  return merged;
}

async function extractArticleAnalysisDualVerified(articleText, options) {
  const timeoutMs = options.timeoutMs ?? 30000;

  // Run both models in parallel
  const [claudeResult, mistralResult] = await Promise.allSettled([
    extractArticleAnalysisViaClaude(articleText, { ...options, timeoutMs }),
    extractArticleAnalysisViaMistral(articleText, { ...options, timeoutMs }),
  ]);

  if (typeof logger !== "undefined") {
    logger.info("background", `Claude: ${claudeResult.status === "fulfilled" ? (claudeResult.value?.ok ? "ok" : claudeResult.value?.error) : claudeResult.reason?.message}`);
    logger.info("background", `Mistral: ${mistralResult.status === "fulfilled" ? (mistralResult.value?.ok ? "ok" : mistralResult.value?.error) : mistralResult.reason?.message}`);
  }

  const claudeOk  = claudeResult.status  === "fulfilled" && claudeResult.value?.ok;
  const mistralOk = mistralResult.status === "fulfilled" && mistralResult.value?.ok;

  // Both failed
  if (!claudeOk && !mistralOk) {
    const ce = claudeResult.status  === "fulfilled" ? claudeResult.value?.error  : claudeResult.reason?.message;
    const me = mistralResult.status === "fulfilled" ? mistralResult.value?.error : mistralResult.reason?.message;
    return { ok: false, error: `Both models failed. Claude: ${ce}. Mistral: ${me}` };
  }

  // Only one succeeded — return it with single_model badge
  if (!claudeOk || !mistralOk) {
    const winner = claudeOk ? claudeResult.value : mistralResult.value;
    const loser  = claudeOk ? "mistral" : "claude";
    return {
      ...winner,
      figures: (winner.figures || []).map(f => ({
        ...f,
        _verification: "single_model",
        _verified_by:  claudeOk ? "claude" : "mistral",
        _loser_error:  claudeOk
          ? (mistralResult.value?.error || "Mistral failed")
          : (claudeResult.value?.error  || "Claude failed"),
      })),
      _meta: { provider: "single_model", winner: claudeOk ? "claude" : "mistral", loser },
    };
  }

  // Both succeeded — merge and compare
  const cv = claudeResult.value;
  const mv = mistralResult.value;

  // Merge main_topics from both (union, deduped)
  const main_topics = [...new Set([...cv.main_topics, ...mv.main_topics])].slice(0, 10);

  // Prefer Claude's summary (it's typically more precise) but note both ran
  const summary = cv.summary || mv.summary;

  const figures = mergeFigures(cv.figures, mv.figures);

  const verifiedCount  = figures.filter(f => f._verification === "dual_verified").length;
  const ambiguousCount = figures.filter(f => f._verification === "ambiguous").length;

  return {
    ok: true,
    summary,
    main_topics,
    figures,
    _meta: {
      provider:      "dual_verified",
      claude_model:  CLAUDE_MODEL,
      mistral_model: MISTRAL_MODEL,
      verified:      verifiedCount,
      ambiguous:     ambiguousCount,
      single_model:  figures.filter(f => f._verification === "single_model").length,
    },
  };
}

// ---------------------------------------------------------------------------
// Unified entry point — background.js calls this, not the individual functions
// Routes based on CONFIG.LLM_PROVIDER
// ---------------------------------------------------------------------------
async function extractArticleAnalysis(articleText, options) {
  const provider = options.provider
    || (typeof CONFIG !== "undefined" && CONFIG.LLM_PROVIDER)
    || "dual";

  switch (provider) {
    case "mistral": return extractArticleAnalysisViaMistral(articleText, options);
    case "claude":  return extractArticleAnalysisViaClaude(articleText, options);
    case "dual":
    default:        return extractArticleAnalysisDualVerified(articleText, options);
  }
}