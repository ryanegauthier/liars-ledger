// Worth Noting - src/ollama.js
// Calls a local or Tailscale-reachable Ollama server to extract per-politician
// policy claims and bill search phrases from article text.

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

function buildPrompt(articleText, labels) {
  const list = labels.map((l) => `- ${l}`).join("\n");
  return (
    "You help map U.S. political news to Congress.gov bill search terms.\n\n" +
    "Article excerpt:\n\"\"\"\n" +
    articleText.trim() +
    '\n"""\n\n' +
    "For EACH politician label below (verbatim `name`), output one object:\n" +
    "- name: exact same string as listed\n" +
    "- claim: one concise sentence — the main policy-related assertion the article makes about this person relative to federal law/legislation; null only if there is truly none\n" +
    "- search_terms: 2-5 short English phrases (nouns/topics) useful for matching bill titles; derive from the claim and nearby sentences; never include the person's name\n\n" +
    "Politician labels:\n" +
    list +
    '\n\nOutput ONLY valid JSON with this shape, no markdown:\n' +
    '{"politicians":[{"name":"...","claim":"...","search_terms":["..."]}]}\n' +
    "Include every label exactly once."
  );
}

/**
 * @param {string} articleText
 * @param {string[]} labels - `matched_as` strings from the resolver
 * @param {{ baseUrl: string, model: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: true, byLabel: Map<string, { claim: string|null, search_terms: string[] }> } | { ok: false, error: string }>}
 */
async function extractPolicyClaimsViaOllama(articleText, labels, options) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const model = options.model;
  const timeoutMs = options.timeoutMs ?? 45000;

  if (!labels.length) {
    return { ok: true, byLabel: new Map() };
  }

  const url = `${baseUrl}/api/chat`;
  const body = {
    model,
    messages: [{ role: "user", content: buildPrompt(articleText, labels) }],
    stream: false,
    format: "json",
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      return { ok: false, error: `Ollama HTTP ${res.status}` };
    }

    const data = await res.json();
    const content = data?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, error: "Ollama returned empty content" };
    }

    const parsed = parseOllamaJson(content);
    const rows = parsed?.politicians;
    if (!Array.isArray(rows)) {
      return { ok: false, error: "Model JSON missing politicians[]" };
    }

    const byLabel = new Map();
    for (const row of rows) {
      const name = typeof row?.name === "string" ? row.name.trim() : "";
      if (!name) continue;
      const claim =
        row.claim === null || row.claim === undefined
          ? null
          : String(row.claim).trim() || null;
      const terms = Array.isArray(row.search_terms)
        ? row.search_terms
            .map((t) => String(t).trim())
            .filter(Boolean)
        : [];
      byLabel.set(name, { claim, search_terms: terms });
    }

    return { ok: true, byLabel };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Ollama request timed out" : e.message;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTopicsFromOllama(byLabel, labels, fallbackTerms) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  const fallback = fallbackTerms.length ? fallbackTerms : [];

  for (const label of labels) {
    const row = byLabel.get(label);
    let terms = row?.search_terms?.length ? [...row.search_terms] : [];
    if (terms.length === 0 && fallback.length) {
      terms = [...fallback];
    }
    const seen = new Set();
    const deduped = [];
    for (const t of terms) {
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(t);
      if (deduped.length >= 8) break;
    }
    out.set(label, deduped);
  }
  return out;
}
