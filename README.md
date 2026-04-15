# Chromium ext for Talent Acquisition 

Chromium extension for offer processing, keyword tagging (cntrl f equivalent) and cost matching. 

## Features

### Offer

- Load a compensation **`.xlsx` / `.xls`** file in the popup (drag-and-drop or browse).
- Parses fixed cell references (annual/monthly salary, allowances, bonus, totals, etc.) via bundled `xlsx-mini.js` (no network).
- **Fill Form Now** injects into the **active tab** and fills SmartRecruiters offer fields by fuzzy-matching labels inside `spl-form-element_*` blocks (including shadow DOM).
- **Currency:** USD → INR is **not** automated; change currency manually when the UI requires it (the popup calls this out).
- Run count is stored locally in `chrome.storage.local` for basic usage tracking.

### Cost assist

- Runs on **`https://*.smartrecruiters.com/*`** (content scripts + popup-driven injection).
- Walks an applicant queue, reads screening answers for expected salary / CTC-style questions (English + many non-English hints), compares to your **max** (and optional **min**) budget, and can advance the workflow when rules match.


### Keyword Cntrl F 

- Comma-separated **keywords** with built-in abbreviation expansion (e.g. ML → machine learning) and optional **custom expansions** (same line format as `keyword_expansions.txt`: `abbr|full form 1, full form 2`), including load-from-`.txt`.
- **Min keywords to match**, optional **post hits to Notes**, **dry run**, and queue **Go** / **Stop** like Cost assist.

### List helper

- `sr-list-autoscroll.js` is injected on SmartRecruiters pages alongside the triage scripts to support list navigation during queues.

## Requirements

- **Chromium** (Chrome, Edge, Brave, etc.) with Manifest V3.

## Install (developer / unpacked)

1. Clone or download this folder.
2. Ensure `icon.png` exists at the project root (or update `manifest.json` to match your icon path).
3. Open `chrome://extensions` (or `edge://extensions`).
4. Enable **Developer mode**.
5. Click **Load unpacked** and select this directory.

## Permissions (summary)

| Permission        | Why |
|-------------------|-----|
| `activeTab`       | Fill offer form on the tab you are using. |
| `scripting`       | Inject fill/triage logic. |
| `storage`         | Save popup settings and usage count. |
| `tabs`            | Background: query/close duplicate SR tabs. |

**Host access:** `https://*.smartrecruiters.com/*`, `https://*.greenhouse.io/*`, `http://localhost/*` (per `manifest.json`). SmartRecruiters-specific automation is registered as **content scripts** only on `smartrecruiters.com`; other hosts are allowed for scripting when you use those sites as the active tab.

## Excel layout (Mr Offer)

The popup maps spreadsheet **cells** to offer labels (see `BINDINGS` in `popup.js`), including pairs like monthly `D10` / annual `E10` for cash salary sections. If some monthly cells are empty, the extension **derives** them from annual values where applicable.

## Development notes

- **No build step:** plain HTML/JS/CSS.
- **No npm dependencies** in-repo; `xlsx-mini.js` is vendored for offline XLSX parsing.
- Content script entrypoints: `sr-list-autoscroll.js`, `salary-triage-core.js`, `salary-triage-autorun.js`, `keyword-triage-core.js`, `keyword-triage-autorun.js`.

## Disclaimer

This tool automates actions inside a third-party ATS. Use it only where your organization’s policies and applicable law allow. **Dry run** modes are provided to inspect behavior before anything clicks “Move” or similar controls.
