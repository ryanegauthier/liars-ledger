// server/providers/mistral.js
// Mistral API provider. Prompt and parser live in _shared.js; retry and
// error categories live in providerFetch.js.

import { buildPrompt, parseContent, TEMPERATURE } from "./_shared.js";
import { fetchWithRetry } from "./providerFetch.js";

const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";
const MISTRAL_MODEL   = "mistral-small-latest";

async function extract(articleText) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) return { ok: false, error: "Mistral API key not configured", category: "upstream" };

  const call = await fetchWithRetry(MISTRAL_API_URL, {
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
  }, { label: "Mistral" });
  if (!call.ok) return call;

  let data;
  try {
    data = await call.res.json();
  } catch {
    return { ok: false, error: "Mistral returned non-JSON response", category: "upstream" };
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: "Mistral returned empty content", category: "upstream" };

  const result = parseContent(content, "Mistral");
  if (result.ok) result._meta = { provider: "mistral", model: MISTRAL_MODEL };
  else result.category = "upstream";
  return result;
}

export const mistral = { extract };
