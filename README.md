# Amazon Seller Central Product Details Sync Extension

Chrome Extension (Manifest V3) for syncing missing product details from an authenticated Amazon Seller Central session.

## What it does

1. Fetches ASINs page-by-page from `GET http://89.117.20.71/WebAPI/Product/NoMPN?PageNo={PageNo}&PageSize=100`
2. Uses the logged-in Seller Central browser session to call `GET https://sellercentral.amazon.com/abis/ajax/reconciledDetailsV3?asin={ASIN}&conditionType=new`
3. Parses `title`, `brand`, `mpn`, `imageUrl`, and `asin`. MPN is resolved in this order: Manufacturer Part Number, Part Number, then Model Number.
4. Posts one product payload per ASIN to `POST http://89.117.20.71/WebAPI/Product/`
5. Processes batches of 100, rechecking page 1 after updates and advancing past already-attempted records until an API page is empty
6. Stores JSONL logs locally and allows export

## Files

- `manifest.json`: extension manifest
- `popup.html`, `popup.js`, `styles.css`: popup UI
- `background.js`: pagination, retries, sequential processing, progress tracking
- `content.js`: authenticated Seller Central request execution
- `api.js`: custom API wrapper and retries
- `amazon.js`: Amazon private API wrapper and retries
- `parser.js`: response parsing
- `storage.js`: `chrome.storage.local` helpers
- `logger.js`: V10 diagnostic logging
- `WORKFLOW.md`: workflow diagram
- `INSTALLATION.md`: installation guide

## Runtime behavior

- Pagination: scans page numbers up to 1000 and at most 50000 products per run. Duplicate detection accepts `id`, `Id`, `productId`, or `ProductId`, includes ASIN to distinguish reused IDs, and falls back to ASIN when ID is missing. ASIN fields can be `asin`, `ASIN`, or `Asin`.
- Repeated pages: stops with an error if different page numbers return identical sets of already-attempted products. A record without both a usable ID and ASIN also produces an explicit error.
- Requests time out after 25 seconds instead of waiting indefinitely.
- Retry behavior: `GET /Product/NoMPN` retries up to 3 times, but ASIN-level Amazon fetch and product save attempts do not retry
- Rate limiting: 500 ms delay between ASINs
- Failure behavior: failed ASINs are logged, then the extension attempts a fallback save with `mpn: "NA"` so the record is skipped on the next run
- Session handling: Seller Central cookies are reused automatically from the logged-in browser session

## Important implementation notes

- The Seller Central private API is called from the page context via the content script so browser authentication is reused automatically.
- MPN checks `manufacturer_part_number`, then `part_number`, then `model_number`, including Amazon's `#1.value` attribute variants. Empty values are skipped so the next available field is used.
- Diagnostic logs include `mpnSource` to show which Amazon attribute supplied the saved MPN.
- `POST /Product` sends `asin`, `title`, `userId`, `accountId`, `brand`, and `mpn`, and missing text fields are normalized to `"NA"`.
- Logs include `asin`, `pageNo`, `status`, `failureReason`, and retry counters.
- Diagnostics are enabled. Page logs include country, response field names, sample identities, missing-ID counts, MPN categories, and new/duplicate counts. API logs include request URL, attempt, HTTP status, and elapsed time; request bodies and authentication cookies are not logged.
- V10 diagnostic logging is enabled. Starting a new run clears the previous run's logs; use **Export Logs** before starting again if the earlier log is needed.

## Local regression checks

Run `node --test tests/sync.test.cjs`. The tests use simulated APIs and do not contact Amazon or save live products.

## Limitations

- Amazon may change the private endpoint or response shape without notice.
- This implementation does not bypass captcha or login requirements.
- The service worker relies on the extension remaining active while the sync runs.
