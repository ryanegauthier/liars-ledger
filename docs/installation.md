---
title: Installation
nav_order: 6
---

# Installation

## From the Chrome Web Store (recommended)

Liar's Ledger is available on the Chrome Web Store. Install directly from there - no developer mode or manual setup required.

→ **[Install from the Chrome Web Store](https://liarsledger.com)**

## From GitHub Releases (manual install)

If you prefer not to install from the Web Store:

1. Go to [github.com/ryanegauthier/liars-ledger/releases](https://github.com/ryanegauthier/liars-ledger/releases)
2. Download the latest `liars-ledger-vX.X.X.zip`
3. Unzip it somewhere permanent on your computer
4. Open the `src` folder and rename `config.example.js` to `config.js`
5. Open Chrome and go to `chrome://extensions`
6. Enable **Developer mode** (toggle in the top right)
7. Click **Load unpacked** and select the unzipped folder
8. The Liar's Ledger icon will appear in your toolbar

No API keys needed - everything runs through `api.liarsledger.com`.

**Note:** Manual installs use a different extension ID than the Web Store version. If your extension ID is not listed in the server's `ALLOWED_ORIGINS`, API calls will be rejected. Contact the maintainer to get your ID added, or run the backend proxy locally.

## From source

```bash
git clone https://github.com/ryanegauthier/liars-ledger.git
cd liars-ledger
cp src/config.example.js src/config.js
```

Load unpacked in `chrome://extensions` pointing at the project root.

### Rebuilding the politician dictionary

The dictionary is committed to the repo and doesn't need to be rebuilt for normal use. To rebuild against the latest Congress.gov data:

```bash
node build-dictionary.js YOUR_CONGRESS_API_KEY
```

Register for a free key at [api.congress.gov/sign-up](https://api.congress.gov/sign-up/).

### Running the backend proxy locally

See [Backend Proxy - Local development](backend-proxy#local-development).

## Building a release zip

```bash
node build-release.js
```

Produces `liars-ledger-vX.X.X.zip` in the project root. The GitHub Actions workflow runs this automatically on every version tag push.

## Usage

1. Navigate to any political news article
2. Click the **Liar's Ledger** icon in your toolbar
3. Click **Scan This Page**
4. Results appear in the bottom bar within a few seconds

Click any politician card to expand their full record. Click **Full Report** to open a standalone report page with all available data.
