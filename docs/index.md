---
title: Home
nav_order: 1
---

# Liar's Ledger

> *The record doesn't lie. Politicians do.*

Liar's Ledger is a Chrome browser extension that detects politicians mentioned in news articles and surfaces their official voting records in real time — no searching, no tab switching.

---

## What it does

1. You click **Scan This Page** on any political news article
2. Two independent AI models extract the specific claim being made about each politician
3. The extension fetches that politician's actual record from three government databases
4. Results appear in a bottom bar — sponsored legislation, roll-call votes, and interest group ratings
5. Pro users get a verdict: does the voting record support or contradict the article's claim?

## Core principles

**Neutral by architecture** — The AI never sees voting data and never makes political judgments during extraction. It only converts article text to structured data. All ground truth comes from official government sources.

**Dual-model verification** — Claude (Anthropic) and Mistral independently analyze each article. When both agree on a claim (Jaccard similarity ≥ 0.65), it's marked as a verified statement. When they disagree, the claim is suppressed rather than shown.

**Anonymous by design** — No account, no email. Each install gets an anonymous UUID token. Nothing is stored server-side that can be traced to a person.

**Keys server-side** — All API keys live in the backend proxy at `api.liarsledger.com`. Nothing sensitive ships in the extension.

---

## Quick links

- [Architecture](architecture) — how the full pipeline works
- [Dual-Model Verification](dual-model-verification) — how claims are extracted and verified
- [Data Sources](data-sources) — Congress.gov, GovTrack, VoteSmart
- [Backend Proxy](backend-proxy) — server architecture and deployment
- [Pricing & Support](pricing) — free and Pro tiers, subscriptions, donations
- [Installation](installation) — Chrome Web Store and developer mode setup
- [Contributing](contributing) — how to help

---

## Data sources

| Source | Data | Key required |
|---|---|---|
| [Congress.gov](https://api.congress.gov) | Sponsored/cosponsored legislation | Yes (server-side) |
| [GovTrack](https://www.govtrack.us/developers/api) | Roll-call vote history | No |
| [VoteSmart](https://votesmart.org) | Interest group ratings, key vote history | Yes (server-side) |

## Project links

- [GitHub repository](https://github.com/ryanegauthier/liars-ledger)
- [liarsledger.com](https://liarsledger.com)
- [Chrome Web Store](https://liarsledger.com)
- [Privacy policy](https://liarsledger.com/privacy)
