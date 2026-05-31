// server/providers/claude.js
// Claude API provider. Prompt and parser live in _shared.js.

import { buildPrompt, parseContent, TEMPERATURE } from "./_shared.js";

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";

async function extract(articleText) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return { ok: false, error: "Claude API key not configured" };

  let res;
  try {
    res = await fetch(CLAUDE_API_URL, {
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
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { ok: false, error: e.name === "TimeoutError" ? "Claude timed out" : e.message };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Claude HTTP ${res.status}: ${body.slice(0, 120)}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "Claude returned non-JSON response" };
  }

  const content = data?.content?.[0]?.text;
  if (!content) return { ok: false, error: "Claude returned empty content" };

  const result = parseContent(content, "Claude");
  if (result.ok) result._meta = { provider: "claude", model: CLAUDE_MODEL };
  return result;
}

export const claude = { extract };
