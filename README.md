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
the result is marked as verified. If they disagree, we show both
interpretations or flag it as ambiguous.

### Confirm and Contradict Equally

Liar's Ledger surfaces voting records whether they confirm or contradict what
a politician is saying. The record might show they've been consistent, that
they've evolved, or that they've voted both ways over time — all of that is
worth knowing.

The sidebar never editorializes. It shows:
- 🟢 Record **consistent** with stated position
- 🔴 Record **inconsistent** with stated position
- ⚪ **No relevant votes found** (also notable)

Draw your own conclusions.

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
  research published, structured extraction
- **Mistral** (Mistral AI) — French AI company, European training data,
  open-weights model, strong neutrality reputation

The models are isolated from voting record data. They only process article
text and return structured JSON identifying claims. All political ground truth
comes from government sources.

Both models receive the same article text. If they independently extract the
same claim, the result is marked **dual-verified**. If they disagree, the
result is flagged as **ambiguous** and both interpretations are surfaced.

## Installation (Developer Mode)

1. Clone this repo
2. Copy `src/config.example.js` to `src/config.js` and add your API keys
3. Run `node build-dictionary.js YOUR_CONGRESS_API_KEY` to generate the
   politician dictionary
4. Open Chrome and go to `chrome://extensions`
5. Enable **Developer mode** (top right)
6. Click **Load unpacked** → select the project folder
7. Navigate to any news article, click the Liar's Ledger icon,
   and hit **Scan This Page**

## Configuration

Copy `src/config.example.js` to `src/config.js` (gitignored) and fill in:

```js
const CONFIG = {
  CONGRESS_API_KEY:  "...",   // congress.gov — free at api.congress.gov/sign-up
  LLM_PROVIDER:      "dual",  // "mistral" | "claude" | "dual" | "ollama"
  MISTRAL_API_KEY:   "...",   // console.mistral.ai — ~$0.001/scan
  CLAUDE_API_KEY:    "...",   // console.anthropic.com — ~$0.001/scan
  LLM_TIMEOUT_MS:    30000,
};
```

For dev with a single provider, set `LLM_PROVIDER: "mistral"` and only fill
in the Mistral key. Switch to `"dual"` when both keys are available.

**Cost reference (per scan):**
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
| 7 | ✅ Done | LLM claim extraction — Mistral live, Claude+dual ready |
| 7a | ✅ Done | GovTrack roll-call votes (Congress.gov vote API not yet available for 119th) |
| 7b | ✅ Done | Nickname resolution — Chuck Schumer, Mitch McConnell, etc. |
| 8 | — | VoteSmart integration (educational license pending) |
| 9 | — | Backend proxy + freemium tier management |
| 10 | — | Creator shareable graphics cards |

## Tests

Requires **Node 18+**.

```bash
npm test
```

Unit tests cover Ollama JSON parsing, topic keywords, name normalization, and bill/vote matching (`src/test/*.test.js`). Shared logic lives in `src/ollama-parse.js` and `src/topic-match.js`.

Optional live Ollama check (server must be running):

```bash
npm run test:integration:ollama
# OLLAMA_HOST=http://100.x.x.x:11434 OLLAMA_MODEL=mistral npm run test:integration:ollama
```

## Firefox

Mostly compatible. The `browser.*` / `chrome.*` shim is already in place.
Full Firefox instructions coming once Chrome version is stable.

## Security

See [SECURITY.md](SECURITY.md) for known risks and pre-release checklist.

## API Keys

Never commit `config.js`. It is gitignored. Use `config.example.js` as
the template.

## Privacy

Liar's Ledger does not collect, store, or transmit:
- Browsing history
- Article content
- User identity
- Location data

Article text is sent to Mistral and/or Claude APIs for claim extraction only.
API calls are not logged by Liar's Ledger. A full privacy policy will be
published before any public release.

## Contributing

Open to PRs, especially for:
- Keeping the politician dictionary current
- Additional news site compatibility
- Firefox / Safari testing

## License

MIT — extension code only. Backend and creator tools are proprietary.