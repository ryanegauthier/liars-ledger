---
title: Data Sources
nav_order: 4
---

# Data Sources

All political ground truth in Liar's Ledger comes from official government sources or non-partisan civic data organizations. The AI never sees voting data and never makes political judgments.

## Congress.gov

**URL:** [api.congress.gov](https://api.congress.gov)  
**What we use:** Sponsored and cosponsored legislation per member  
**Key required:** Yes (free, server-side)  
**Rate limit:** 5,000 requests/hour

Congress.gov is the official U.S. government source for congressional records. We fetch up to 50 sponsored and 50 cosponsored bills per member per scan, then filter by topic relevance using a two-pass matching algorithm:

1. **Pass 1** - keyword category matching against 19 predefined topic buckets
2. **Pass 2** - direct title substring match against the LLM's per-figure `search_terms`

Results are deduplicated by bill URL and untitled amendments are filtered out.

## GovTrack

**URL:** [govtrack.us/developers/api](https://www.govtrack.us/developers/api)  
**What we use:** Roll-call vote history (Yea/Nay/Not Voting) per member  
**Key required:** No  
**Note:** Used instead of Congress.gov vote endpoints, which return 404 for the 119th Congress

GovTrack member IDs are resolved from bioguide IDs using the `unitedstates/congress-legislators` dataset hosted at `unitedstates.github.io`. The bioguide→GovTrack ID map is session-cached after the first fetch.

Vote matching uses both direct topic string matching and a category expansion map that translates VoteSmart/GovTrack category names (e.g. "Finance and Banking") to our internal topic keywords (e.g. "taxation", "federal budget").

## VoteSmart

**URL:** [app.votesmart-api.org](https://app.votesmart-api.org)  
**What we use:** Interest group ratings + vote history  
**Key required:** Yes (educational license, server-side)  
**Note:** CORS-blocked from browsers - all calls go through the backend proxy

VoteSmart provides ratings from major interest groups including:

| Group | Category |
|---|---|
| NRA | Guns |
| ACLU | Civil Rights |
| AFL-CIO | Labor |
| Club for Growth | Fiscal Conservative |
| Human Rights Campaign | LGBTQ Rights |
| Sierra Club | Environment |
| VFW | Veterans |
| NORML | Marijuana Policy |
| Planned Parenthood | Reproductive Rights |
| American Family Association | Social Conservative |
| US Chamber of Commerce | Business |

Ratings are scored 0–100. The most recent year's rating per group is shown.

VoteSmart uses JWT authentication. The backend proxy handles token refresh automatically - a single `_tokenPromise` guard prevents concurrent requests from triggering multiple simultaneous re-authentication calls.

## Politician dictionary

The extension ships with a 3,606-key dictionary covering all 536 current members of the 119th Congress. Keys include full names, common nicknames, and middle-initial variants.

Nickname resolution handles common cases automatically: Chuck Schumer → Charles E. Schumer, Mitch McConnell → Addison McConnell, Ted Cruz → Rafael Cruz, Bernie Sanders → Bernard Sanders, and 40+ others.

The dictionary is built with `node build-dictionary.js` using the Congress.gov members API and is committed to the repo as `src/data/politicians.json`.
