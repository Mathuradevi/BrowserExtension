# Installation Guide

1. Open Chrome.
2. Navigate to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the `BrowserExtension` folder from this project, or the copied folder at `C:\Work\CompetitorIntelligence\BrowserExtension`.
6. Pin the extension if needed.
7. Log in to Amazon Seller Central in the same Chrome profile.
8. Open the extension popup and click `Start Sync`.

## Required access

- `https://sellercentral.amazon.com/*`
- `http://89.117.20.71/*`

## Operational notes

- Keep Seller Central authenticated before starting.
- If Amazon presents captcha, solve it manually and start the sync again.
- V11 resolves MPN from Manufacturer Part Number, Part Number, or Model Number and records the selected source in diagnostic logs.
- Diagnostic logging and the **Export Logs** button are available. Export the JSONL file after the run and before starting another run.
