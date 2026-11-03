// server/providers/_shared.js
// Single source of truth for buildPrompt() and parseContent().
// Imported by claude.js and mistral.js - never duplicated.
//
// IMPORTANT: When changing the prompt or parser, change it HERE only.
// The extension-side copy in src/llm.js must be kept manually in sync
// (the two ecosystems can't share a file directly - ESM server vs importScripts).
// To verify sync: diff the buildPrompt() body here against src/llm.js.

export const MAX_ARTICLE_CHARS = 12000;
export const TEMPERATURE       = 0.0;   // deterministic output across all providers

export function buildPrompt(articleText) {
  const excerpt = articleText.trim().slice(0, MAX_ARTICLE_CHARS);
  return (
    "You analyze U.S. political news for a browser extension that queries Congress.gov.\n\n" +
    "Read the article excerpt. Then output ONLY valid JSON (no markdown) with this exact shape:\n" +
    '{"article_summary":"2-5 sentences in plain English what the piece is about politically",' +
    '"main_topics":["2-8 short noun phrases for Congress.gov bill search - policy areas only, no names"],' +
    '"figures":[' +
    '{"lookup_name":"the person\'s name as the article gives it, with every title, honorific, party label, and role word removed - for example \\"Elizabeth Warren\\", never \\"Sen. Warren\\" or \\"Democratic Sen. Elizabeth Warren\\"; use the full first and last name when the article gives it, otherwise the surname alone",' +
    '"claim":"one sentence: the article\'s main policy-related assertion about this person, or null",' +
    '"search_terms":["2-6 short phrases for bill title search - never include the person\'s name"]}' +
    "]}\n\n" +
    "Rules:\n" +
    "- Include every person named in the article who holds, held, or is seeking elected office, or who is named with a political or government title (for example Rep., Sen., Gov., state senator, attorney general), even if their role is secondary. Omit the President and Vice President.\n" +
    "- Do not decide whether a person serves in the U.S. Congress. A title such as \"Rep.\" can mean a state legislator. Membership is checked separately against the official roster, so include the person either way.\n" +
    "- A title is never a name: \"Republican Gov. Joe Lombardo\" is the person \"Joe Lombardo\", and words like \"Gov\", \"Republican\", or \"U.S. Rep\" must never appear in lookup_name. Periods in abbreviations such as Gov., Sen., Rep., Dr., Jr., and U.S. do not end a name.\n" +
    "- Include at most 10 figures. If more than 10 qualify, prefer people described as members of Congress, then the people the article discusses most. If none qualify, use an empty figures array.\n" +
    "- Never return the same person twice with different name formats (e.g. 'Bernie Sanders' and 'Sanders' are the same person - use the full name once).\n" +
    "- main_topics must reflect the dominant legislation/policy threads in the article.\n" +
    "- Order main_topics from most to least prominent in the article - the topic given the most attention or mentioned most often comes first.\n" +
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
