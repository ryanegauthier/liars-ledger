# Worth Noting

A browser extension that surfaces the voting records of politicians mentioned in news articles — in real time, as you read.

> *Worth noting: they voted the opposite way.*

## How It Works

1. Detects politician names in the article you're reading
2. Matches them to their official voting record
3. Surfaces relevant votes in a sidebar — no searching, no tab switching

## Design Philosophy

Worth Noting is a neutral research tool, not a gotcha machine. It surfaces 
voting records whether they confirm or contradict what a politician is saying. 
The record might show they've been consistent, that they've evolved, or that 
they've voted both ways over time — all of that is worth knowing.

The sidebar never editorializes. It shows:
- 🟢 Votes in line with the stated position
- 🔴 Votes against the stated position
- ⚪ No votes found on this topic (also notable)

Draw your own conclusions.

## Data Sources

- [ProPublica Congress API](https://projects.propublica.org/api-docs/congress-api/) — recent votes and bill details (free, no key required)
- [VoteSmart](https://votesmart.org/share/api) — historical votes and issue ratings (free with registration)
- [GovTrack](https://www.govtrack.us/developers/api) — deeper vote history and ideology scores (free)

## Installation (Developer Mode)

1. Clone this repo
2. Copy src/config.example.js to src/config.js and add your API keys
3. Open Chrome and go to chrome://extensions
4. Enable Developer mode (top right)
5. Click Load unpacked and select the project folder
6. Navigate to any news article and open DevTools Console to verify

## Project Status

| Step | Status | Description |
|------|--------|-------------|
| 1 | Done | Manifest, skeleton, message passing |
| 2 | Next | Article detection and politician name extraction |
| 3 | - | Politician name to ID dictionary |
| 4 | - | ProPublica API integration |
| 5 | - | VoteSmart API integration |
| 6 | - | Sidebar UI |
| 7 | - | GovTrack integration |

## API Keys

Never commit config.js. It is gitignored. Use config.example.js as the template.

## License

MIT
