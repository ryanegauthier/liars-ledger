// Liars Ledger - src/ollama.js
// Calls Ollama for article-level analysis (uses src/ollama-parse.js).

/**
 * @param {string} articleText
 * @param {{ baseUrl: string, model: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: true, summary: string, main_topics: string[], figures: Array<{ lookup_name: string, claim: string|null, search_terms: string[] }> } | { ok: false, error: string }>}
 */
async function extractArticleAnalysisViaOllama(articleText, options) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const model = options.model;
  const timeoutMs = options.timeoutMs ?? 90000;

  const url = `${baseUrl}/api/chat`;
  const body = {
    model,
    messages: [{ role: "user", content: buildArticleAnalysisPrompt(articleText) }],
    stream: false,
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

    const { summary, main_topics, figures } = parseArticleAnalysisContent(content);
    return { ok: true, summary, main_topics, figures };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Ollama request timed out" : e.message;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
