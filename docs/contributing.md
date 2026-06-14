---
title: Contributing
nav_order: 7
---

# Contributing

Liar's Ledger is open source. Contributions are welcome, especially in these areas:

## Politician dictionary

The dictionary covers the 119th Congress. It needs updating when:
- New members are sworn in mid-session
- Members change their preferred names
- Nicknames are missing (the LLM returns a name the dictionary doesn't resolve)

To rebuild: `node build-dictionary.js YOUR_CONGRESS_API_KEY`

To add a nickname manually, edit `src/lookup.js` - find `FULL_NAME_OVERRIDES` (for full name substitutions) or `NICKNAME_FIRST` (for first-name substitutions).

## News site compatibility

`content.js` uses a priority selector list to find article body text. Some sites use unusual markup. If the extension fails to extract article text on a site, the fix is usually adding a site-specific selector to the list in `content.js`.

## Firefox support

The `browser.*` / `chrome.*` shim is already in place throughout the codebase. Firefox compatibility testing and AMO submission are planned but not yet done.

## What we're not looking for

- Changes to the AI prompt or Jaccard threshold without data supporting the change
- New data sources without a corresponding proxy provider in `server/providers/`
- Any change that puts API keys in the extension bundle

## Development setup

```bash
git clone https://github.com/ryanegauthier/liars-ledger.git
cd liars-ledger
cp src/config.example.js src/config.js
```

Load the extension in Chrome developer mode. Run the backend proxy locally for full functionality - see [Installation](installation).

## Submitting changes

1. Fork the repository
2. Create a branch: `git checkout -b fix/your-fix-name`
3. Make your changes
4. Test with at least two different political news articles
5. Open a pull request with a description of what changed and why

## Reporting issues

Open a GitHub issue at [github.com/ryanegauthier/liars-ledger/issues](https://github.com/ryanegauthier/liars-ledger/issues).

Include:
- The URL of the article you were scanning (if applicable)
- The debug log output (copy from the popup's Debug Log panel)
- Chrome version and OS
