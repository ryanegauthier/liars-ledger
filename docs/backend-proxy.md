---
title: Backend Proxy
nav_order: 5
---

# Backend Proxy

## Overview

The Liar's Ledger backend proxy runs at `api.liarsledger.com` (Node.js/Express, deployed on Render). It holds all API keys server-side so nothing sensitive ships in the extension.

## Routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check — returns status, version, timestamp |
| `POST` | `/api/claude/extract` | Claude claim extraction |
| `POST` | `/api/mistral/extract` | Mistral claim extraction |
| `GET` | `/api/congress/*` | Congress.gov proxy (appends API key) |
| `GET` | `/api/votesmart/*` | VoteSmart proxy (handles JWT auth) |

## Request format

Both LLM endpoints accept:

```json
{ "articleText": "..." }
```

And return the standard shape:

```json
{
  "ok": true,
  "summary": "...",
  "main_topics": ["..."],
  "figures": [
    {
      "lookup_name": "Sen. Sanders",
      "claim": "...",
      "search_terms": ["..."]
    }
  ]
}
```

## Deployment

The proxy is deployed on [Render](https://render.com) (Starter plan, $7/month — always-on, no cold starts). Auto-deploy triggers on every push to `main`.

Environment variables set in Render:

| Variable | Description |
|---|---|
| `CLAUDE_API_KEY` | Anthropic API key |
| `MISTRAL_API_KEY` | Mistral API key |
| `CONGRESS_API_KEY` | Congress.gov API key |
| `VOTESMART_EMAIL` | VoteSmart account email |
| `VOTESMART_PASSWORD` | VoteSmart account password |
| `ALLOWED_ORIGINS` | Comma-separated Chrome extension origin(s) |

## CORS

Only requests from the Chrome extension are allowed. The `ALLOWED_ORIGINS` environment variable contains the extension's `chrome-extension://` origin. Requests from any other origin are rejected.

## Rate limiting

60 requests per minute per IP (via `express-rate-limit`). This is generous for current traffic and will be tightened when freemium tier management is implemented.

## Error handling

All async route handlers are wrapped with a `wrap()` helper that catches rejected promises and routes them to Express error middleware. The global error handler ensures the client always receives a JSON response instead of hanging.

Provider `extract()` functions guard `res.json()` in try/catch — a non-JSON upstream response returns `{ ok: false, error: "...returned non-JSON response" }` rather than throwing.

## Prompt consistency

The prompt sent to both Claude and Mistral is defined in `server/providers/_shared.js` — a single source of truth. Both providers import `buildPrompt` and `parseContent` from this file. The extension-side copy in `src/llm.js` is kept manually in sync.

## Local development

```bash
cd server
cp .env.example .env
# Fill in .env with your keys
npm install
npm run dev
# Server runs at http://localhost:3001
```

Point the extension at localhost by setting in `src/config.js`:

```js
PROXY_URL:            "http://localhost:3001",
CLAUDE_API_ENDPOINT:  "http://localhost:3001/api/claude/extract",
MISTRAL_API_ENDPOINT: "http://localhost:3001/api/mistral/extract",
```
