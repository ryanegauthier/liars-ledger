---
title: Data Sources
nav_order: 4
---

# Data Sources

All political ground truth in Liar's Ledger comes from official government sources or non-partisan civic data organizations. The AI never sees voting data and never makes political judgments during the extraction step.

## Congress.gov

**URL:** [api.congress.gov](https://api.congress.gov)
**What we use:** Sponsored and cosponsored legislation per member
**Key required:** Yes (free, server-side)
**Rate limit:** 5,000 requests/hour

Congress.gov is the official U.S. government source for congressional records. We fetch up to 100 sponsored and 100 cosponsored bills per member per scan, then filter by topic relevance using a two-pass matching algorithm:

1. **Pass 1** - keyword category matching against 26 predefined topic buckets (including dedicated `israel` and `foreign policy` categories covering Gaza, arms sales, ceasefires, and security assistance)
2. **Pass 2** - word-aware match against the LLM's per-figure `search_terms`: at least one non-filler word from the term must appear in the bill title/description, rather than requiring every word verbatim. This avoids false negatives on real terms like "healthcare reform" (official bill titles rarely contain the literal word "healthcare") and false positives from generic padding words ("reform", "funding", "expansion") being trusted as distinctive on their own. Matching is word-boundary aware, so a short word can't match inside an unrelated word (e.g. "public" no longer matches inside "Republic").

Results are deduplicated by bill URL and title prefix, with re-introduced bills (same title, new bill number each Congress) collapsed to their most recent version. Ceremonial bills (honoring, congratulating, commemorating, designating, etc.) are filtered out before display.

## GovTrack

**URL:** [govtrack.us/developers/api](https://www.govtrack.us/developers/api)
**What we use:** Roll-call vote history (Yea/Nay/Not Voting) per member
**Key required:** No
**Note:** Used instead of Congress.gov vote endpoints, which return 404 for the 119th Congress

GovTrack member IDs are resolved from bioguide IDs using the `unitedstates/congress-legislators` dataset hosted at `unitedstates.github.io`. The bioguide→GovTrack ID map is cached in `browser.storage.session` after the first fetch.

We fetch the 50 most recent votes per member and filter by topic relevance using direct string matching, a category expansion map that translates GovTrack category names (e.g. "Finance and Banking") to internal topic keywords (e.g. "taxation", "federal budget"), and the same word-aware fallback described above for non-category LLM search terms.

## VoteSmart

**URL:** [app.votesmart-api.org](https://app.votesmart-api.org)
**What we use:** Interest group ratings + vote history
**Key required:** Yes (educational license, server-side)
**Note:** CORS-blocked from browsers - all calls go through the backend proxy
**Available:** Free and Pro tiers

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
| Americans for Democratic Action | Liberal |
| Americans for Tax Reform | Fiscal Conservative |

Ratings are scored 0–100. The most recent year's rating per group is shown.

VoteSmart uses JWT authentication. The backend proxy handles token refresh automatically - a single `_tokenPromise` guard prevents concurrent requests from triggering multiple simultaneous re-authentication calls.

### ID resolution

VoteSmart identifies politicians by a numeric `candidateId`, not a bioguide ID. Resolution tries a fast path first, falling back to a paginated `by-lastname` lookup (`perPage=50`, all pages fetched) if needed. Common issues handled:

- **Office+state fast path**: `/v1/officials/by-office-id` fetches a member's entire state delegation in one call, matched by office, state, last name, and first name/nickname. This replaced a previously assumed endpoint, `/v1/officials/by-office-state`, which was never real on VoteSmart's API (confirmed against their own Swagger spec) and had been silently 502ing 100% of the time. The fast path requires an exact last-name match in addition to office/state/first-name, since the state delegation it returns isn't narrowed by surname and two members can share a common first name or nickname.
- **Compound surnames**: politicians whose VoteSmart record files a multi-word last name (e.g. "Gluesenkamp Perez") are retried with the compound form if the simple surname lookup fails
- **Preferred names**: VoteSmart's `firstName` field may differ from the politician's public name; `nickName` and `preferredName` fields are also checked
- **Pagination failures**: if any page of results fails after retries, the lookup salvages whatever pages succeeded and flags the result as `partial` - the scan is not charged when a partial result is detected
- **Batched lookups**: member lookups (Congress.gov + GovTrack + VoteSmart fetches per member) are processed in batches of 3 concurrently, not all at once - VoteSmart's API load-sheds under burst concurrency from a single client, and batching eliminated a repeated 502 storm seen live on multi-member scans

## Politician dictionary

The extension ships with a 3,606-key dictionary covering all members of Congress from the 110th through 119th Congress (~1,340 members). Keys include full names, common nicknames, first-name variants, and middle-initial forms.

Nickname resolution handles common cases automatically: Chuck Schumer → Charles E. Schumer, Mitch McConnell → Addison McConnell, Ted Cruz → Rafael Cruz, Bernie Sanders → Bernard Sanders, and 40+ others.

The dictionary is built with `node scripts/build-dictionary.cjs` using the Congress.gov members API and is committed to the repo as `src/data/politicians.json`.
