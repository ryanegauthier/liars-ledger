# Production LLM migration (Anthropic Claude & Minstrel)

This document is for **scheduling and checklist work** when you move off local **Ollama** and ship a build that calls **Anthropic (Claude)** and/or **Minstrel** safely.

Calendar dates are **not** fixed here: pick a **public launch week**, then assign real dates to each milestone using the **T‑minus** offsets below.

---

## Milestone table (assign dates when launch week is known)

| Milestone | Suggested timing | What to complete |
|-----------|------------------|-------------------|
| M1 — Provider accounts & contracts | **T‑8 weeks** before launch | Anthropic org billing, API key policy, and (if used) Minstrel account/plan. Confirm terms allow browser-backed or server-mediated article analysis for your product. |
| M2 — Backend proxy (staging) | **T‑6 weeks** | A small HTTPS service that holds **Claude** / **Minstrel** / Congress keys, accepts a **short article excerpt** + optional hints, returns the **same JSON shape** the extension expects today (`article_summary`, `main_topics`, `figures[]`). No provider keys in the extension bundle. |
| M3 — Extension adapter | **T‑5 weeks** | Replace or branch `extractArticleAnalysisViaOllama` with a provider-agnostic caller (e.g. `CONFIG.LLM_PROXY_URL` + `CONFIG.LLM_PROVIDER`). `manifest.json` `host_permissions` must include only your proxy origin (and Congress.gov), not generic LLM hosts. |
| M4 — Minstrel routing (optional) | **T‑4 weeks** | If Minstrel is a **router** or second provider: define failover (e.g. primary Claude, fallback Minstrel) and rate limits in the proxy, not in the extension. |
| M5 — Privacy & retention | **T‑3 weeks** | Privacy policy published; server logs must not retain full article text (or define TTL/redaction). Align with Chrome Web Store disclosures. |
| M6 — Security review | **T‑2 weeks** | Re-run `SECURITY.md` checklist; remove `src/config.js` from `web_accessible_resources` in distributed builds; narrow `<all_urls>` if possible. |
| M7 — Production cutover | **Launch week** | Point production extension at production proxy; monitor errors/latency; keep Ollama path for internal QA if useful. |

**T‑0** = the day you intend users to install the store build (or start paid beta).

---

## Why a proxy is required for Claude (and usually Minstrel)

- **Secrets:** Anthropic API keys must not ship inside a public extension.
- **CORS and key restrictions:** Vendor APIs are intended for **server-to-server** or tightly controlled clients; a first-party backend avoids blocked requests and key leakage.
- **One contract:** Keep the extension dumb: `POST /v1/article-analysis` (your API) with stable JSON in/out; swap Claude vs Minstrel inside the server without another store submission.

---

## JSON contract (keep stable across providers)

The extension pipeline expects analysis JSON equivalent to:

- `article_summary` — string  
- `main_topics` — string[]  
- `figures[]` — `{ lookup_name, claim, search_terms[] }`

Any provider (Claude, Minstrel, Ollama behind the proxy) should normalize to this shape **on the server** before responding.

---

## Code touchpoints (today)

- Prompt + Ollama HTTP: `src/ollama.js` (`extractArticleAnalysisViaOllama`)
- Orchestration: `background.js` (`handleAnalyze`)
- Config template: `src/config.example.js`

Production work is mostly **new adapter + proxy**; Congress.gov logic in `src/api.js` stays as-is aside from keys moving server-side if you choose.

---

## After launch

- Rotate proxy credentials on a schedule; monitor Anthropic/Minstrel dashboards for quota and spend caps.  
- Document your **actual** M1–M7 calendar dates in this file or your internal wiki once set.
