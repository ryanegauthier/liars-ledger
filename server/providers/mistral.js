// server/providers/mistral.js
// Mistral API provider for the proxy server.

const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";
const MISTRAL_MODEL   = "mistral-small-latest";

async function extract(articleText) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) return { ok: false, error: "Mistral API key not configured" };

  let res;
  try {
    res = await fetch(MISTRAL_API_URL, {
      method: "POST",
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
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { ok: false, error: e.name === "TimeoutError" ? "Mistral timed out" : e.message };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Mistral HTTP ${res.status}: ${body.slice(0, 120)}` };
  }

  const data    = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: "Mistral returned empty content" };

  return parseContent(content, "Mistral");
}

export const mistral = { extract };

// ── Shared prompt + parser ────────────────────────────────────────────────────

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
    "- Only include people who are clearly discussed as federal lawmakers (current Congress).\n" +
    "- Include at most 10 figures. If none qualify, use an empty figures array.\n" +
    "- Use the most formal version of each person's name consistently. Never return the same person twice with different name formats (e.g. 'Sen. Sanders' and 'Sen. Bernie Sanders' are the same person — pick one).\n" +
    "- main_topics must reflect the dominant legislation/policy threads in the article.\n" +
    "- search_terms must be useful for matching bill titles.\n\n" +
    "Article excerpt:\n\"\"\"\n" + excerpt + '\n"""'
  );
}

function parseContent(content, providerName) {
  let raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const start = raw.indexOf("{");
  const end   = raw.lastIndexOf("}");
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, error: `${providerName} returned unparseable JSON` }; }

  const summary = typeof parsed?.article_summary === "string" ? parsed.article_summary.trim() : "";
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

  return { ok: true, summary, main_topics, figures, _provider: providerName };
}
