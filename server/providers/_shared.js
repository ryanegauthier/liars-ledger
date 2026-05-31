// server/providers/_shared.js
// Single source of truth for buildPrompt() and parseContent().
// Imported by claude.js and mistral.js — never duplicated.
//
// IMPORTANT: When changing the prompt or parser, change it HERE only.
// The extension-side copy in src/llm.js must be kept manually in sync
// (the two ecosystems can't share a file directly — ESM server vs importScripts).
// To verify sync: diff the buildPrompt() body here against src/llm.js.

export const MAX_ARTICLE_CHARS = 12000;
export const TEMPERATURE       = 0.0;   // deterministic output across all providers

export function buildPrompt(articleText) {
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
    "Article excerpt:\n\"\"\"\n" + excerpt + '\n"""'
  );
}

export function parseContent(content, providerName) {
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
    const claim = row.claim == null ? null : String(row.claim).trim() || null;
    const search_terms = Array.isArray(row.search_terms)
      ? row.search_terms.map(t => String(t).trim()).filter(Boolean) : [];
    figures.push({ lookup_name, claim, search_terms });
  }

  return { ok: true, summary, main_topics, figures };
}
