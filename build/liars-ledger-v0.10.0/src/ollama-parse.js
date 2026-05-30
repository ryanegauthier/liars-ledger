// Liars Ledger - src/ollama-parse.js
// Pure helpers for Ollama JSON parsing and topic merging (testable in Node).

function stripJsonFences(text) {
  const t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(t);
  return fence ? fence[1].trim() : t;
}

function parseOllamaJson(content) {
  const raw = stripJsonFences(content);
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error("Could not parse JSON from model output");
  }
}

// const MAX_ARTICLE_CHARS = 12000;

function buildArticleAnalysisPrompt(articleText) {
  const excerpt = articleText.trim().slice(0, MAX_ARTICLE_CHARS);
  return (
    "You analyze U.S. political news for a browser extension that queries Congress.gov.\n\n" +
    "Read the article excerpt. Then output ONLY valid JSON (no markdown) with this exact shape:\n" +
    '{"article_summary":"2-5 sentences in plain English what the piece is about politically",' +
    '"main_topics":["2-8 short noun phrases for Congress.gov bill search — policy areas only, no names"],' +
    '"figures":[' +
    '{"lookup_name":"string that can identify a current U.S. Senator or Representative — prefer \\"Sen. Lastname\\", \\"Rep. Lastname\\", \\"Senator Lastname\\", or \\"Representative Lastname\\"; use the surname as it is usually written in Congress",' +
    '"claim":"one sentence: the article\\u0027s main policy-related assertion about this person, or null",' +
    '"search_terms":["2-6 short phrases for bill title search — never include the person\\u0027s name"]}' +
    "]}\n\n" +
    "Rules:\n" +
    "- Only include people who are clearly discussed as federal lawmakers (current Congress). Omit the President, Vice President, Cabinet, governors, candidates not in Congress, and vague references.\n" +
    "- Include at most 10 figures. If none qualify, use an empty figures array.\n" +
    "- main_topics must reflect the dominant legislation/policy threads in the article.\n" +
    "- search_terms must be useful for matching bill titles (e.g. \"border security\", \"child tax credit\").\n\n" +
    "Article excerpt:\n\"\"\"\n" +
    excerpt +
    '\n"""'
  );
}

/**
 * @param {string} content - raw model message text
 * @returns {{ summary: string, main_topics: string[], figures: Array<{ lookup_name: string, claim: string|null, search_terms: string[] }> }}
 */
function parseArticleAnalysisContent(content) {
  const parsed = parseOllamaJson(content);
  const summary =
    typeof parsed?.article_summary === "string" ? parsed.article_summary.trim() : "";
  const main_topics = Array.isArray(parsed?.main_topics)
    ? parsed.main_topics.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const rawFigures = Array.isArray(parsed?.figures) ? parsed.figures : [];
  const figures = [];
  for (const row of rawFigures) {
    const lookup_name = typeof row?.lookup_name === "string" ? row.lookup_name.trim() : "";
    if (!lookup_name) continue;
    const claim =
      row.claim === null || row.claim === undefined
        ? null
        : String(row.claim).trim() || null;
    const search_terms = Array.isArray(row.search_terms)
      ? row.search_terms.map((t) => String(t).trim()).filter(Boolean)
      : [];
    figures.push({ lookup_name, claim, search_terms });
  }
  return { summary, main_topics, figures };
}

function dedupeTopicStrings(terms, max = 10) {
  const seen = new Set();
  const out = [];
  for (const t of terms) {
    const s = String(t).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function mergeTopicsForMember(figure, mainTopics, fallbackTopics) {
  const raw = [];
  if (figure?.search_terms?.length) raw.push(...figure.search_terms);
  if (mainTopics?.length) raw.push(...mainTopics);
  if (!raw.length) return dedupeTopicStrings(fallbackTopics, 12);
  for (const t of fallbackTopics) raw.push(t);
  return dedupeTopicStrings(raw, 12);
}
