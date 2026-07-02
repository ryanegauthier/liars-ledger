---
title: Backend Proxy
nav_order: 5
---

# Backend Proxy

## Overview

The Liar's Ledger backend proxy runs at `api.liarsledger.com` (Node.js/Express, deployed on Render). It holds all API keys server-side, enforces tier gating, manages scan counting, and handles Square subscription webhooks.

## Routes

### Auth and token management

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/register` | None | Issue a new anonymous UUID token; rate-limited to 5/hr per IP |
| `GET` | `/api/scan-status` | Bearer token | Return tier, scansToday, limit, remaining for this token |
| `POST` | `/api/scan/start` | Bearer token | Reserve a scan slot; returns `scanToken` + `commitToken` or `429` |
| `POST` | `/api/scan/commit` | Bearer token | Finalize a reserved scan (deduct from daily count) |

### AI extraction (requires valid scanToken)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/claude/extract` | Bearer + scanToken | Claude claim extraction; strips Pro fields for free tier |
| `POST` | `/api/mistral/extract` | Bearer + scanToken | Mistral claim extraction; strips Pro fields for free tier |

### Government data proxies

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/congress/*` | Bearer token | Congress.gov proxy (appends API key, query-param allowlist) |
| `GET` | `/api/govtrack/*` | Bearer token | GovTrack proxy (query-param allowlist) |
| `GET` | `/api/legislators` | Bearer token | `unitedstates/congress-legislators` dataset (bioguide → GovTrack ID map) |
| `GET` | `/api/votesmart/*` | Bearer token | VoteSmart proxy (handles JWT auth + refresh) |

### Pro features

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/verify-claim` | Bearer token (Pro) | Claim-vs-record verdict via Claude; requires Pro tier |

### Billing and subscriptions

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/pricing/checkout` | None | Create Square payment link with token embedded as `order.reference_id`; rate-limited to 3/hr per IP |
| `POST` | `/square/webhook` | Square HMAC signature | Handle Square subscription/invoice events; upgrade/downgrade tier in Redis |
| `POST` | `/restore-token` | None | Look up anonymous token from Square order reference (receipt recovery) |

### Utility

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Returns status, version, timestamp |

## Request format

LLM extraction endpoints accept:

```json
{ "articleText": "...", "scanToken": "..." }
```

`scanToken` is required. The backend's `requireScanToken` middleware rejects requests without a valid, unconsumed token. The same token is reused for both Claude and Mistral calls in dual-model mode — one scan, two extraction calls, one token.

Both endpoints return:

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

`summary` and `claim` are stripped from the response for free-tier tokens server-side.

## Authentication

All API routes except `/register`, `/pricing/checkout`, `/square/webhook`, and `/restore-token` require a `Bearer <tokenId>` header. Token validation reads from Upstash Redis. On Redis failure, the server fails closed (503) unless `AUTH_FAIL_OPEN=true` (development only).

## Environment variables

| Variable | Description |
|---|---|
| `CLAUDE_API_KEY` | Anthropic API key |
| `MISTRAL_API_KEY` | Mistral API key |
| `CONGRESS_API_KEY` | Congress.gov API key |
| `VOTESMART_EMAIL` | VoteSmart account email |
| `VOTESMART_PASSWORD` | VoteSmart account password |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
| `SQUARE_ACCESS_TOKEN` | Square API access token |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Square webhook HMAC key |
| `SQUARE_SUBSCRIPTION_PLAN_VARIATION_ID` | Square subscription plan variation ID |
| `ALLOWED_ORIGINS` | Comma-separated Chrome extension origin(s) + `https://liarsledger.com` |
| `AUTH_FAIL_OPEN` | `true` to skip auth on Redis errors (dev only, never production) |

## CORS

Requests are restricted to origins in `ALLOWED_ORIGINS`: the extension's `chrome-extension://` ID and `https://liarsledger.com`. All other origins are rejected.

## Rate limiting

- General API routes: 60 requests/minute per IP
- `/register`: 5 requests/hour per IP
- `/pricing/checkout`: 3 requests/hour per IP

`trust proxy: 1` is set so Render's reverse proxy passes the real client IP for rate limit calculations.

## Scan token security

The `requireScanToken` middleware on extraction endpoints ensures that calling Claude or Mistral directly (bypassing `/api/scan/start`) is rejected with 403. Tokens are single-use: consumed on the first valid extraction call and invalidated immediately in Redis.

## Error handling

All async route handlers are wrapped with a `wrap()` helper that catches rejected promises and routes them to Express error middleware. The global error handler ensures the client always receives a JSON response.

Provider `extract()` functions guard `res.json()` in try/catch — a non-JSON upstream response returns `{ ok: false, error: "...returned non-JSON response" }` rather than throwing.

## Prompt consistency

The prompt sent to both Claude and Mistral is defined in `server/providers/_shared.js` — a single source of truth. Both providers import `buildPrompt` and `parseContent` from this file. The extension-side copy in `src/llm.js` is kept manually in sync.

## Deployment

The proxy is deployed on [Render](https://render.com) (Starter plan, $7/month — always-on, no cold starts). Auto-deploy triggers on every push to `main` via `server/render.yaml`.

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
