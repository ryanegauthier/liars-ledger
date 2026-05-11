# Liars Ledger

A browser extension that surfaces the voting records of politicians mentioned in news articles — in real time, as you read.

> *Liars ledger: they voted the opposite way.*

## How It Works

1. Detects politician names in the article you're reading
2. Matches them to their official voting record
3. Surfaces relevant votes in a sidebar — no searching, no tab switching

## Design Philosophy

Liars Ledger is a neutral research tool, not a gotcha machine. It surfaces voting records whether they confirm or contradict what a politician is saying. The record might show they've been consistent, that they've evolved, or that they've voted both ways over time — all of that is worth knowing.

The sidebar never editorializes. It shows:
- 🟢 Votes **in line** with the stated position
- 🔴 Votes **against** the stated position
- ⚪ **No votes found** on this topic (also notable)

Draw your own conclusions.

## Data Sources

- [Congress.gov API](https://api.congress.gov) — official U.S. government source, member data and votes (free, 5000 req/hour)
- [VoteSmart](https://votesmart.org/share/api) — historical votes and issue ratings (free with registration)
- [GovTrack](https://www.govtrack.us/developers/api) — deeper vote history and ideology scores (free, no key needed)

## Installation (Developer Mode)

1. Clone this repo
2. Copy `src/config.example.js` to `src/config.js` and add your API keys
3. Run `node build-dictionary.js YOUR_CONGRESS_API_KEY` to generate the politician dictionary
4. Open Chrome and go to `chrome://extensions`
5. Enable **Developer mode** (top right)
6. Click **Load unpacked** → select the project folder
7. Navigate to any news article, click the Liars Ledger icon, and hit **Scan This Page**

## Firefox

Mostly compatible. The `browser.*` / `chrome.*` shim is already in place.
Full Firefox instructions coming once Chrome version is stable.

## Project Status

| Step | Status | Description |
|------|--------|-------------|
| 1 | ✅ Done | Manifest, skeleton, message passing |
| 2 | ✅ Done | Article detection + politician name extraction |
| 3 | 🔜 Next | Politician name → ID dictionary (Congress.gov) |
| 4 | — | Congress.gov vote lookup |
| 5 | — | VoteSmart integration |
| 6 | — | Sidebar UI |
| 7 | — | GovTrack integration |

## API Keys

Never commit `config.js`. It is gitignored. Use `config.example.js` as the template.

## Contributing

Open to PRs, especially for:
- Keeping the politician dictionary current
- Additional news site compatibility
- Firefox / Safari testing

## License

MIT
