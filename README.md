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
official U.S. government sources — Congress.gov. We don't editorialize, 
summarize, or interpret the record. We display it as-is.

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

Worth Noting surfaces voting records whether they confirm or contradict what 
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
  source, member data and votes (free, 5000 req/hour)
- [VoteSmart](https://votesmart.org/share/api) — historical votes and issue 
  ratings (free with registration, educational license pending)
- [GovTrack](https://www.govtrack.us/developers/api) — deeper vote history 
  and ideology scores (free, no key needed)

## AI Models Used

Claim extraction uses two independent models to reduce bias:

- **Claude** (Anthropic) — US-based AI safety company, Constitutional AI 
  research published, structured extraction
- **Mistral** (Mistral AI) — French AI company, European training data, 
  open-weights model, strong neutrality reputation

The models are isolated from voting record data. They only process article 
text and return structured JSON identifying claims. All political ground truth 
comes from government sources.

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

## Firefox

Mostly compatible. The `browser.*` / `chrome.*` shim is already in place.
Full Firefox instructions coming once Chrome version is stable.

## Project Status

| Step | Status | Description |
|------|--------|-------------|
| 1 | ✅ Done | Manifest, skeleton, message passing |
| 2 | ✅ Done | Article detection + politician name extraction |
| 3 | ✅ Done | Politician dictionary — 536 members, 3606 keys |
| 4 | ✅ Done | Congress.gov API integration, session caching |
| 5 | ✅ Done | Debug log panel with copy/clear |
| 6 | ✅ Done | Bottom bar sidebar UI |
| 7 | 🔜 Next | LLM claim extraction (Mistral dev, Claude+Mistral prod) |
| 8 | — | VoteSmart integration (educational license pending) |
| 9 | — | Backend proxy + freemium tier management |
| 10 | — | Creator shareable graphics cards |

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

Article text is processed locally or via API calls that are not logged.
A full privacy policy will be published before any public release.

## Contributing

Open to PRs, especially for:
- Keeping the politician dictionary current
- Additional news site compatibility
- Firefox / Safari testing

## License

MIT — extension code only. Backend and creator tools are proprietary.