# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NIQ TA Helper is a Chrome Manifest V3 extension for NIQ talent acquisition workflows inside SmartRecruiters. It has three features: **Mr Offer** (XLSX offer letter auto-fill), **Cost Assist** (salary budget screening), and **Keyword Search** (keyword/boolean resume tagging).

**No build step. No npm. No external dependencies.** Source files are shipped directly to Chrome.

## Running Tests

Tests use Node's built-in test runner (`node:test`) — no install needed.

```bash
# Run all tests
node --test tests/*.test.js

# Run a single test file
node --test tests/boolean-parser.test.js
node --test tests/salary-parsing.test.js
node --test tests/keyword-matching.test.js
node --test tests/keyword-expansions.test.js

# E2E (Playwright, dev-only — headed locally, headless when CI=1)
cd tests/e2e && npm ci && npx playwright test
```

## Releasing

CI (`.github/workflows/ci.yml`) runs unit + e2e tests on every push/PR and uploads a packaged zip as a build artifact.

1. Bump `"version"` in `manifest.json` (semver: MAJOR = breaking workflow/stored-data change, MINOR = feature, PATCH = fix).
2. Add a matching `## [x.y.z] - YYYY-MM-DD` entry at the top of `CHANGELOG.md` — `tests/release.test.js` fails if they differ.
3. Commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`. The tag build checks tag == manifest version and publishes a GitHub Release with `niq-ta-helper-vX.Y.Z.zip` and the changelog notes.

Distribute only zips built by `scripts/package.sh` (CI or local) — never hand-zip the folder, which ships tests, docs and dev config.

## Loading the Extension

1. Open `chrome://extensions/`
2. Enable Developer mode
3. Click "Load unpacked" and select this directory

After editing any file, click the refresh icon on the extension card in `chrome://extensions/`.

## Architecture

### Content Script Load Order

`manifest.json` defines two content script groups injected at `document_idle` on `*.smartrecruiters.com/*`. Order within each group matters:

**Group 1 (all frames):** `sr-selectors.js` → `sr-list-autoscroll.js` → `salary-triage-core.js` → `keyword-expansions.js` → `keyword-triage-core.js`

**Group 2 (main frame only):** `storage-session-shim.js` → `keyword-expansions.js` → `salary-triage-autorun.js` → `keyword-triage-autorun.js`

`keyword-expansions.js` must load before `keyword-triage-core.js` because the core file reads `KEYWORD_EXPANSIONS` and `KEYWORD_TYPO_ALIASES` from the global scope set by the expansions file.

`storage-session-shim.js` must load before the autorun files because they read/write queue state through the `__srSessionGet/Set/Remove` globals it defines (see Storage Locations).

### Feature Split: Core vs Autorun

Each feature is split into two files:

- **`*-core.js`** — pure logic injected into candidate profile pages. Exposes `__sr*` globals. Testable (the test suite imports these directly via `require()`). These files use an IIFE `(function(){ "use strict"; ... })()` and also expose named exports for Node test compatibility.
- **`*-autorun.js`** — state machine that manages the URL queue stored in `chrome.storage.session` (via the `storage-session-shim.js` async wrapper — **not** raw `sessionStorage`). Reads queue state on page load, calls core functions, then navigates to the next URL. Each autorun also has a `runAsParallelWorker()` path that takes precedence when the page is a background worker tab (`srIsParallelWorker` → matching `feature`): it runs the core once, reports `srWorkerDone` to the background, and lets the background navigate the tab to the next URL. The session-queue path is the single-tab fallback.

The popup **Stop** buttons (Cost Assist and Keyword) both call one global `stopEverything()` — it sets `srAbortAll`, tears down any parallel queue, clears both session queues, and closes worker tabs. So Stop kills whatever is running regardless of which tab the popup happens to open on.

### Background Service Worker (`background.js`)

Holds no state in memory that matters: Chrome may stop the service worker at any time (~30s idle), so everything a run needs is in `chrome.storage.session`. Manages:
- Parallel worker tab orchestration (creates/reuses 2–3 worker tabs, routes messages between them and the popup via `chrome.runtime.onMessage`). One generic queue drives **both** Keyword and Cost Assist; a `feature: "keyword" | "salary"` discriminator selects the result shape, the saved last-run key (`keywordTriageLastRun` vs `salaryTriageLastRun`), and the done-notification wording. Start messages: `srStartParallelKeywordQueue` / `srStartParallelSalaryQueue`. `srIsParallelWorker` returns `{ active, feature }` so each autorun claims **only** its own feature's worker tabs (both `salary-triage-autorun.js` and `keyword-triage-autorun.js` run on every profile page). Cost Assist needs no resume-focus dance — it reads screening answers from the DOM with no PDF render, so its worker tabs stay hidden.
- **Per-URL leases + watchdog.** The queue is one `srParallelQueue` object in `chrome.storage.session`, with a state per URL: `pending → leased(tabId, leaseUntil) → done | failed`. All reads/writes go through `withQueue()`, which serializes concurrent messages and persists before the next caller. Rules that keep results correct:
  - A tab's `srIsParallelWorker` call is its **check-in**: it marks the lease `started` and starts the work timeout (`WORK_TIMEOUT_MS`: keyword 180s, salary 90s). Before check-in the lease has `START_TIMEOUT_MS` (60s).
  - `srWorkerDone` is accepted **only** from the tab holding a **started** lease. Duplicates, stale tabs and non-workers are ignored, so no URL is recorded twice or under another URL's result.
  - Any resume-focus/capture message from a worker renews its lease, so a slow-but-alive tab is never timed out.
  - The `srQueueWatchdog` alarm (every 30s; alarms wake a stopped service worker, `setTimeout` doesn't) reclaims expired leases: close the tab, retry once (`MAX_ATTEMPTS = 2`), then `failed: "timeout"`. It also abandons runs older than 2h (GDPR).
  - A tab the recruiter closes mid-profile → `failed: "tab_closed"` (not retried); closed between profiles → URL goes back to `pending`.
  - The run finishes when no URL is `pending` or `leased`; results are saved in input order.
  - A `failed` result is `{ url, error }` with no scan data. Anything that shows results must treat `error` as "not scanned", never as 0 hits / not moved — a recruiter reads "0 hits" as "candidate lacks the skills". The popup's Last run log formats results through `run-summary.js` (`formatKeywordResult`, `summarizeKeywordRun`; tested by `tests/run-summary.test.js`), and the done notification counts failures separately.
  - Tested by `tests/background-queue.test.js`, which runs the real `background.js` in a simulated browser (`tests/helpers/background-harness.js`) with service-worker restarts, hung/closed tabs and duplicate messages. Any change to the queue should add a scenario there.
- Completion notifications (`chrome.notifications`) and audio beep (injected into an active SR tab via `chrome.scripting.executeScript`, since `AudioContext` is unavailable in service workers)
- Tab cleanup on queue completion
- **Resume-render focus handshake** — worker tabs are created `active: false`, but pdf.js does not render in hidden tabs (Chrome pauses `requestAnimationFrame` when `visibilityState === "hidden"`), so the resume text layer never appears and extraction falls back to SR profile chrome. The core requests `srRequestResumeFocus` before extracting the resume; the background `resumeFocus` manager briefly foregrounds that worker tab (serialized — one at a time, focus hands off directly between workers), then restores the user's tab on `srReleaseResumeFocus` (or a 25s safety timeout). The core only requests focus when `document.visibilityState !== "visible"`, so single-tab/foreground runs are unaffected.
- **Resume attachment fallback** — when the inline viewer still won't render after the focus handshake + retries, the core clicks the "Resume" attachment (which opens the resume in a new tab) after `srArmResumeCapture`. The background catches that tab by `openerTabId`, foregrounds it so pdf.js renders, extracts text via `chrome.scripting.executeScript`, closes it, and returns the text on `srGetResumeCapture`. Only fires on chrome-only extractions, so it doesn't slow the normal path. Any **other** tab a leased worker tab opens (seen live: `ensureResumeTabActive`'s fuzzy "resume" click can hit the "Latest Resume" attachment link) is closed on `tabs.onCreated` — the lease check goes through `withQueue` so it holds right after an SW restart, and tabs opened from non-worker (recruiter) tabs are never closed. Tested in `tests/background-queue.test.js` ("tabs opened by worker tabs"). The captured resume text lives **only in-memory** in `resumeCapture.results` (a `Map`), is deleted as soon as the worker reads it via `srGetResumeCapture`, and is never persisted to `chrome.storage`; any unread entry dies with the service worker (~30s idle). Arm entries self-expire after 15s. This in-memory-only lifecycle is intentional for GDPR data-minimization — raw resume text never touches disk here.

### Shadow DOM Traversal

SmartRecruiters uses web components (`spl-button`, `spl-tab`, `sr-link`). All DOM queries go through:
- `walkShadow(node, visitor, visited)` — depth-first traversal that crosses shadow roots
- `queryDeepSelectorAll(root, win, selector)` — shadow-piercing `querySelectorAll`

Never use plain `document.querySelector` for SR elements — it won't find them inside shadow roots.

### Anti-Detection

All navigation delays use `jitter(baseMs)` (±35% randomization). Worker tabs are reused across URLs rather than opened fresh. Do not replace `jitter()` calls with fixed delays.

### Storage Locations

- `chrome.storage.local` — all user settings and last-run results (persists across sessions)
- `chrome.storage.session` — the parallel queue (`srParallelQueue`, background only) and the single-tab URL queues for active Cost Assist and Keyword Search runs, the latter accessed through the `__srSessionGet/Set/Remove` globals in `storage-session-shim.js`. This is extension-isolated and in-memory (cleared when the browser closes), unlike page-origin `sessionStorage`. Do not reintroduce raw `sessionStorage` for queue state — see GDPR Data Handling.

### GDPR Data Handling

This extension processes candidate PII (names, salaries, resume text) and is deliberately built for data minimization. When changing storage or persistence, preserve these invariants:

- **No raw candidate/resume data on disk.** Raw resume text lives only in-memory (the background `resumeCapture.results` `Map`, deleted on read — see Resume attachment fallback) and is never written to `chrome.storage.local` or IndexedDB.
- **No persistent run history.** The former `run-history.js` IndexedDB module (which persisted run records across sessions) was **removed** for GDPR compliance. Do not reintroduce on-disk run history; if run history is ever needed again, keep it in `chrome.storage.session` (in-memory, cleared on browser close).
- **Queue state is extension-isolated and ephemeral** via `chrome.storage.session` rather than page-origin `sessionStorage`. Both the seed (core `startQueueFromPage` / `__srSalaryTriageStartQueue`) and the resume (`*-autorun.js`) go through the `__srSession*` shim — never raw `sessionStorage`, which the SmartRecruiters page can read.
  - **Gotcha (access level):** `chrome.storage.session` defaults to `TRUSTED_CONTEXTS`, which excludes content scripts. `background.js` `ensureSessionAccess()` calls `chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })` (awaiting its **Promise** — the callback form may never fire) on cold start / install / startup, and the popup awaits a `srEnsureSessionAccess` message **before** seeding so access is granted before any content-script write. The shim surfaces `chrome.runtime.lastError` (write resolves `false`, message stashed on `globalThis.__srSessionLastError`) so denied writes fail loudly instead of silently navigating to an empty queue. (Parallel mode is unaffected — its queue is written only by the background, which is a trusted context; workers read their config from `srParallelWorkerConfig` in `chrome.storage.local`.)
  - **Gotcha (predates-reload tabs):** reloading the extension does **not** re-inject declared content scripts into already-open tabs, so the shim (`__srSession*`) would be missing there. The popup's `ensureSalaryCore` / `ensureKeywordCore` therefore inject `storage-session-shim.js` **first** in their `files` list, before the core. If you add another popup-triggered injection that seeds the queue, include the shim the same way.
- `chrome.storage.local` is for **settings and aggregate last-run summaries only** — never raw resume text or per-candidate PII dumps. (Exception: per-profile `lastRunDiag_<timestamp>` diagnostics are capped at 20 and intended for debugging; treat them as PII and avoid widening their retention.)

These invariants are enforced by `tests/gdpr-data-handling.test.js`, which scans the shipped source files (comments stripped) and fails if raw `sessionStorage`, IndexedDB, or a run-history module reappears, or if the `setAccessLevel` call is removed.

### Salary Parsing (`salary-triage-core.js`)

`parseSalaryNumber()` handles: Indian formats (LPA, lakhs, crore, Indian comma grouping), Western formats (k/K suffix, currency symbols, plain numbers), and ranges (always returns upper bound). `scoreQuestion()` uses fuzzy hint matching to identify which form field contains the salary question.

### Keyword Matching (`keyword-triage-core.js` + `keyword-expansions.js`)

Two search modes:
- **Keywords mode**: comma-separated terms with abbreviation expansion via `keyword-expansions.js`, prefix wildcard support (`Python*`), ISO list splitting, and token-index bigram matching
- **Boolean mode**: LinkedIn Recruiter syntax parsed into an AST (`parseBooleanQuery` → `evaluateBooleanAst`). Operator precedence: NOT > AND > OR. Implicit AND between adjacent terms. Quoted phrases are single TERM nodes.

### XLSX Parser (`xlsx-mini.js`)

Self-contained async XLSX parser with no external dependencies (no SheetJS, no DOM parser). Supports reading a named sheet (`parseXLSX(buffer, sheetName)`, resolved via `workbook.xml` + rels). Used exclusively by the Mr Offer tab: `popup.js` reads the **"External"** or **"Internal"** sheet of the "New Fitments_India Base Pay" workbook (popup toggle, persisted as `offerSheetName` in `chrome.storage.local`; External is the default), locating each Pay Element row by its column-B label (`BINDINGS_BY_SHEET` maps offer-form field labels → Pay Element labels per sheet) and taking the amount from the "Proposed" column (E). Only offer-form fields marked required (*) are filled. Tested by `tests/xlsx-mini.test.js`.

**The External and Internal tabs are independent calculators** — nothing links them; each has its own WFA Level and Proposed Total Base Pay input cells, and a recruiter may fill only one. The popup keeps the dropped file's bytes in memory (never persisted) so the toggle re-parses without re-dragging, and shows a passive hint when the selected tab looks like an untouched template (≥3 zero/empty fields) while the other tab holds more values. The Internal SmartRecruiters offer form is not yet mapped — `BINDINGS_BY_SHEET.Internal` currently reuses the External bindings; give it its own array once the internal form's field labels are known.

## Lessons

### Reported keyword misses: diagnose, don't guess

When a user reports "keyword X missed on profile Y", the matching logic in `keyword-triage-core.js` is rarely the cause. A keyword miss can come from any of three layers, and they need different evidence:

1. **Matching gap** — the canonical/expansion forms in `KEYWORD_EXPANSIONS` don't cover the variant used in the resume. The regex fallback in `sepFlexiblePatternSource` enforces a `(?![A-Za-z0-9])` boundary, so a single-token keyword won't match a longer compound word that contains it (e.g. `docker` won't match `Dockerfile` without an explicit expansion entry). Fix by adding the compound forms to the expansion table.
2. **Extraction failure** — the resume text never reaches `findKeywordHits`. Common in PDF resumes where pdf.js text layers don't render all pages, or where the resume tab isn't activated in time.
3. **Exclusion over-strip** — `stripExcludedText` removes ALL occurrences of any ≥10-char sidebar phrase from `allText`. If the resume and the job-description sidebar happen to share a long phrase, the resume's keywords inside that phrase are also nuked.

Before changing code: open the popup → **Inspect diagnostics** (the per-profile `lastRunDiag_<timestamp>` entries saved in `chrome.storage.local`, capped at 20). For the failing profile, grep `extractedText` and each `textSources.*` segment for the missed keyword:

- Keyword present in `extractedText` → matching bug. Fix in `keyword-expansions.js` or `findKeywordHits`.
- Keyword present in `textSources.fullPage` but not in `extractedText` → exclusion/strip bug. Fix in `stripExcludedText` or `EXCLUDED_SELECTORS`.
- Keyword absent from every source → extraction bug. Fix in the relevant `get*Text` function or the resume-tab/iframe wait logic.

Do not propose fixes from screenshots alone — unit tests with realistic text usually pass even when production fails, because the bug is upstream of matching. The diagnostic capture (added in `runKeywordTriageWithDoc` / `runBooleanTriageWithDoc`) exists specifically to remove that ambiguity.
