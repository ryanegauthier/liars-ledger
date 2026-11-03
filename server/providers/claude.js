// server/providers/claude.js
// Claude API provider. Prompt and parser live in _shared.js; retry and
// error categories live in providerFetch.js.

import { buildPrompt, parseContent, TEMPERATURE } from "./_shared.js";
import { fetchWithRetry } from "./providerFetch.js";

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";

async function extract(articleText) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return { ok: false, error: "Claude API key not configured", category: "upstream" };

  const call = await fetchWithRetry(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:       CLAUDE_MODEL,
      max_tokens:  1024,
      temperature: TEMPERATURE,
      messages:    [{ role: "user", content: buildPrompt(articleText) }],
    }),
  }, { label: "Claude" });
  if (!call.ok) return call;

  let data;
  try {
    data = await call.res.json();
  } catch {
    return { ok: false, error: "Claude returned non-JSON response", category: "upstream" };
  }

  const content = data?.content?.[0]?.text;
  if (!content) return { ok: false, error: "Claude returned empty content", category: "upstream" };

  const result = parseContent(content, "Claude");
  if (result.ok) result._meta = { provider: "claude", model: CLAUDE_MODEL };
  else result.category = "upstream";
  return result;
}

export const claude = { extract };
