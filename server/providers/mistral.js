// server/providers/mistral.js
// Mistral API provider. Prompt and parser live in _shared.js.

import { buildPrompt, parseContent, TEMPERATURE } from "./_shared.js";

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
        temperature: TEMPERATURE,
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

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "Mistral returned non-JSON response" };
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: "Mistral returned empty content" };

  const result = parseContent(content, "Mistral");
  if (result.ok) result._meta = { provider: "mistral", model: MISTRAL_MODEL };
  return result;
}

export const mistral = { extract };
