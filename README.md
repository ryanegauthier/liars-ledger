# Liar's Ledger

**The record doesn't lie. Politicians do.**

> *See if politicians' voting records match what they say in the news.*

---

## The Problem

A politician says they support clean energy. But did they vote for it? A senator claims they've always fought for border security. Have they?

You'd have to search Congress.gov, cross-reference bill numbers, look up roll-call votes, and check interest group ratings for every politician, on every article. Aint nobody got time for that.

## The Solution

Liar's Ledger does it in seconds.

Click **Scan This Page** on any political news article. Liar's Ledger reads the article, identifies every member of Congress mentioned, extracts the policy claims being made about them, and checks those claims against their actual voting record.

The result appears right on the page - no searching, no tab switching, no guessing.

## What You Get

**A verdict on every claim.** Does the politician's record support what the article says about them, contradict it, or give mixed signals? Every verdict cites specific bills, vote positions, and interest group ratings.

- ✓ **Supported** - their record backs the claim
- ✗ **Contradicted** - their record says otherwise
- ⚠ **Mixed** - some evidence each way
- - **Insufficient** - not enough data to judge

**Real legislation, not opinions.** Bills they sponsored. Bills they cosponsored. How they voted. What the NRA, ACLU, AFL-CIO, and Chamber of Commerce think of them. All sourced from official government data.

**20 years of Congress.** 1,340 members covering the 110th through 119th Congress (2007–2026). Current members and former members alike - because politicians who left office still made promises while they were in it.

**Works on any news site.** BBC, CNN, Fox News, NYT, your local paper, political blogs - if it mentions a member of Congress, Liar's Ledger will check the record.

## Data Sources

All data comes from official, non-partisan public sources:

- **[Congress.gov](https://www.congress.gov)** - Sponsored and cosponsored legislation, provided by the Library of Congress
- **[GovTrack](https://www.govtrack.us)** - Roll-call vote history for both chambers
- **[VoteSmart](https://justfacts.votesmart.org)** - Interest group ratings from organizations across the political spectrum

## How It Works Under the Hood

Two independent AI models (Claude by Anthropic and Mistral AI) read the article and extract the policy claims. They never see voting data and never make political judgments. They only convert natural language to structured data.

The voting record comes from government APIs. The comparison between claim and record happens in a separate verification step that cites specific evidence. At no point does the extension editorialize or take a political position.

## Install

**Chrome Web Store:** [Install Liar's Ledger](#) *(link coming)*
This is the recommended way to install. No configuration needed.

**Manual install (developers/testers):**
1. Download the latest release from [Releases](https://github.com/ryanegauthier/liars-ledger/releases)
2. Unzip the folder
3. Open `chrome://extensions` → enable Developer mode → Load unpacked → select the folder
4. Your extension ID (shown on the extensions page) must be authorized by the backend to function. Open an issue or contact the maintainer with your extension ID to request access.

## Developer Setup

If you want to fork, contribute, or run your own instance, you'll need your own API keys and backend. The production proxy at `api.liarsledger.com` does not accept requests from unauthorized extension IDs.

1. Clone this repo
2. Copy `src/config.example.js` to `src/config.js` - update with your own proxy URL
3. Copy `server/.env.example` to `server/.env` - add your own API keys:
   - `CONGRESS_API_KEY` - free at [api.congress.gov/sign-up](https://api.congress.gov/sign-up/)
   - `CLAUDE_API_KEY` - [console.anthropic.com](https://console.anthropic.com)
   - `MISTRAL_API_KEY` - [console.mistral.ai](https://console.mistral.ai)
   - `VOTESMART_EMAIL` / `VOTESMART_PASSWORD` - requires [VoteSmart educational API license](https://votesmart.org/share/api)
4. `cd server && npm install && npm run dev`
5. To rebuild the politician dictionary: `node scripts/build-dictionary.cjs YOUR_CONGRESS_API_KEY`

See [docs.liarsledger.com](https://docs.liarsledger.com) for full architecture documentation.

## Privacy

Liar's Ledger does not collect browsing history, store articles you scan, or track you in any way. The extension only activates when you click Scan. Full privacy policy at [liarsledger.com/privacy.html](https://liarsledger.com/privacy.html).

## Security

See [SECURITY.md](SECURITY.md) for architecture details and the completed pre-release checklist.

## Contributing

Pull requests are welcome for:
- **Politician dictionary** - adding missing members or aliases
- **Topic keywords** - expanding `TOPIC_TITLE_KEYWORDS` coverage in `topic-match.js`
- **Frontend fixes** - sidebar styling, report layout, accessibility
- **Browser compatibility** - Firefox / Safari testing

The backend proxy and API integrations (VoteSmart, Congress.gov, LLM providers) are maintained by the core team only. If you have ideas for backend changes, open an issue first.

**Note:** The extension runs against a live backend with metered API costs. Please don't submit PRs that significantly increase the number of API calls per scan without discussion.

## Links

- **Website:** [liarsledger.com](https://liarsledger.com)
- **Documentation:** [docs.liarsledger.com](https://docs.liarsledger.com)
- **Privacy Policy:** [liarsledger.com/privacy.html](https://liarsledger.com/privacy.html)
- **Changelog:** [CHANGELOG.md](CHANGELOG.md)

## License

MIT - extension code. Backend proxy and creator tools are proprietary.

---

Built by [Gauthier Development](https://liarsledger.com). Independent. Non-partisan. Open source. No ads.
