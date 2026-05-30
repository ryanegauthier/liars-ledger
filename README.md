# Liar's Ledger

A browser extension that surfaces the voting records of politicians mentioned
in news articles — in real time, as you read.

> *The record doesn't lie. Politicians do.*

## How It Works

1. Detects politician names in the article you're reading
2. Uses AI to extract the specific claim being made about each politician
3. Matches that claim against their official voting record
4. Surfaces the result in a bottom bar — no searching, no tab switching

## Design Philosophy

### Neutral by Architecture

Liar's Ledger is designed to be politically neutral at every layer:

**The AI doesn't interpret voting records.**
Two independent AI models (Claude by Anthropic and Mistral by a French AI
company) extract only what the article says about each politician. They never
see voting data, never make political judgments, and never decide if a
politician is being truthful. They convert natural language to structured data.
That's it.

**The voting record is government data.**
All voting records, sponsored bills, and legislative history come directly from
official U.S. government sources — Congress.gov and GovTrack. We don't
editorialize, summarize, or interpret the record. We display it as-is.

**Your code does the matching.**
The comparison between what a politician says and what they've done happens in
deterministic code — not AI. If their record aligns with their stated position,
we show that. If it contradicts it, we show that too.

**Two models, independently verified.**
Using two AI models from different companies with different training data
reduces the risk of systematic bias. If both models extract the same claim,
the result is marked **dual-verified**. If they disagree, we show both
interpretations and flag it as **ambiguous** — that nuance is worth knowing.

### Claim Verification States

Every extracted claim gets one of three states:

| State | Meaning | Display |
|---|---|---|
| ✓ Verified Statement | Claude and Mistral independently extracted the same claim (Jaccard ≥ 0.55) | Green border, verified label |
| ⚠ Models Disagreed | Both models ran but extracted different claims | Amber border, both interpretations shown |
| Single model | Only one model returned a result | Plain italic claim |

### Confirm and Contradict Equally

Liar's Ledger surfaces voting records whether they confirm or contradict what
a politician is saying. The sidebar never editorializes — it shows the record
and lets you draw your own conclusions.

## Data Sources

- [Congress.gov API](https://api.congress.gov) — official U.S. government
  source, member data, sponsored/cosponsored legislation (free, 5000 req/hour)
- [GovTrack](https://www.govtrack.us/developers/api) — roll-call vote history
  for both chambers, free, no key required
- [VoteSmart](https://votesmart.org/share/api) — interest group ratings,
  issue positions, historical key votes (educational license pending)

## AI Models Used

Claim extraction uses two independent models to reduce bias:

- **Claude** (Anthropic) — US-based AI safety company, Constitutional AI
  research, structured extraction via backend proxy
- **Mistral** (Mistral AI) — French AI company, European training data,
  open-weights model, strong neutrality reputation

Both models receive the same article text via the backend proxy. API keys
never leave the server. All political ground truth comes from government sources.

## Backend Proxy

Production API keys are held server-side at `api.liarsledger.com` (Node.js/Express
on Render). The extension calls the proxy, never external APIs directly. This
eliminates key exposure and enables freemium tier management.

```
Extension → api.liarsledger.com/api/analyze → Claude + Mistral (parallel)
                                             → Congress.gov
                                             → VoteSmart (coming)
```

## Installation (Developer Mode)

1. Clone this repo
2. Copy `src/config.example.js` to `src/config.js` and add your API keys
3. Copy `server/.env.example` to `server/.env` and add your API keys
4. Run `node build-dictionary.js YOUR_CONGRESS_API_KEY` to generate the
   politician dictionary
5. Open Chrome and go to `chrome://extensions`
6. Enable **Developer mode** (top right)
7. Click **Load unpacked** → select the project folder
8. Navigate to any news article, click the Liar's Ledger icon,
   and hit **Scan This Page**

## Configuration

Copy `src/config.example.js` to `src/config.js` (gitignored):

```js
const CONFIG = {
  CONGRESS_API_KEY:     "...",   // congress.gov — free
  LLM_PROVIDER:         "dual",  // "mistral" | "claude" | "dual" | "ollama"
  CLAUDE_API_KEY:       "...",   // console.anthropic.com (direct dev mode only)
  MISTRAL_API_KEY:      "...",   // console.mistral.ai (direct dev mode only)
  CLAUDE_API_ENDPOINT:  "https://api.liarsledger.com/api/claude/extract",  // proxy
  MISTRAL_API_ENDPOINT: "https://api.liarsledger.com/api/mistral/extract", // proxy
  LLM_TIMEOUT_MS:       30000,
};
```

**Cost reference (per scan, proxy mode):**
| Mode | Cost |
|------|------|
| Mistral only | ~$0.00024 |
| Claude only | ~$0.00075 |
| Dual (production) | ~$0.001 |

1000 scans ≈ $1.00.

## Project Status

| Step | Status | Description |
|------|--------|-------------|
| 1 | ✅ Done | Manifest, skeleton, message passing |
| 2 | ✅ Done | Article detection + politician name extraction |
| 3 | ✅ Done | Politician dictionary — 536 members, 3606 keys |
| 4 | ✅ Done | Congress.gov API integration, session caching |
| 5 | ✅ Done | Debug log panel with copy/clear |
| 6 | ✅ Done | Bottom bar sidebar UI |
| 7 | ✅ Done | LLM claim extraction — dual-model live |
| 7a | ✅ Done | GovTrack roll-call votes |
| 7b | ✅ Done | Nickname resolution (Chuck Schumer, Mitch McConnell, etc.) |
| 8 | ✅ Done | Two-pass bill matching, amendment filter, dedup |
| 9 | ✅ Done | Backend proxy — api.liarsledger.com live on Render |
| 9a | ✅ Done | Verified/ambiguous UI — green badge, both interpretations |
| 10 | — | VoteSmart integration (educational license pending) |
| 11 | — | Freemium tier management |
| 12 | — | Creator shareable graphics cards |

## Firefox

Mostly compatible. The `browser.*` / `chrome.*` shim is already in place.
Full Firefox instructions coming once Chrome version is stable.

## Security

See [SECURITY.md](SECURITY.md) for known risks and pre-release checklist.

## API Keys

Never commit `config.js` or `server/.env`. Both are gitignored.
Use `config.example.js` and `server/.env.example` as templates.

## Privacy

Liar's Ledger does not collect, store, or transmit:
- Browsing history
- Article content beyond what's sent to Claude/Mistral for claim extraction
- User identity or location data

Article text is sent to the backend proxy which forwards to Claude and Mistral
for claim extraction only. The proxy does not log article content.
A full privacy policy will be published before any public release.

## Contributing

Open to PRs, especially for:
- Keeping the politician dictionary current
- Additional news site compatibility
- Firefox / Safari testing

## License

MIT — extension code only. Backend and creator tools are proprietary.
