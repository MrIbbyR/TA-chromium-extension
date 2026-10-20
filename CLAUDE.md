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

# Type check (dev-only TypeScript 7, checks only // @ts-check files)
cd tests/typecheck && npm ci && npx tsc -p tsconfig.json
```

**Type checking** is opt-in per file: a file starting with `// @ts-check` is checked by `tsc` in strict mode, using JSDoc types. Add it to `files` in `tests/typecheck/tsconfig.json` when you add the comment (`tests/typecheck-coverage.test.js` fails otherwise). Cross-file globals (`__SR`, `__srKw`, `KEYWORD_EXPANSIONS`…) are declared in `tests/typecheck/globals.d.ts`; `__SR`'s type comes from `sr-selectors.js`, so a misspelt `SR.sel.<name>` is a type error. Checked so far: `keyword-dom.js`, `keyword-matching.js`. Still to do: the other `keyword-*.js` modules. Their imports come through `need()` and are untyped (`any`); type them with `/** @type {typeof import("./keyword-dom.js")} */` when they're checked.

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

**Group 1 (all frames):** `sr-selectors.js` → `sr-list-autoscroll.js` → `salary-triage-core.js` → `keyword-expansions.js` → `location-gazetteer.js` → `location-infer.js` → `keyword-dom.js` → `keyword-matching.js` → `keyword-extract.js` → `keyword-pipeline.js` → `keyword-notes.js` → `keyword-diag.js` → `keyword-triage-core.js`

**Group 2 (main frame only):** `storage-session-shim.js` → `keyword-expansions.js` → `salary-triage-autorun.js` → `keyword-triage-autorun.js`

`sr-selectors.js` must load first: every file that touches the SR DOM reads its selectors from the `__SR` global it defines (see SmartRecruiters Selectors). The popup's `ensureSalaryCore` / `ensureKeywordCore` inject it before the core, `popup.html` loads it before `popup.js`, and `background.js` pulls it in with `importScripts`.

`keyword-expansions.js` must load before `keyword-matching.js` because it reads `KEYWORD_EXPANSIONS` and `KEYWORD_TYPO_ALIASES` from the global scope set by the expansions file. Likewise `location-gazetteer.js` → `location-infer.js` must precede `keyword-extract.js` (it reads `__srLocation`). The popup's `ensureKeywordCore` and the e2e spec inject the same files in the same order; `tests/keyword-modules.test.js` checks all three lists.

`storage-session-shim.js` must load before the autorun files because they read/write queue state through the `__srSessionGet/Set/Remove` globals it defines (see Storage Locations).

### Keyword Modules

The keyword core is split by job, in load order: `keyword-dom.js` (shadow-piercing queries, visibility, clicks) → `keyword-matching.js` (normalization, `findKeywordHits`, boolean parser; no DOM) → `keyword-extract.js` (resume/header/location/screening text, resume focus and attachment fallback) → `keyword-pipeline.js` (Move Forward, applicant-list harvesting) → `keyword-notes.js` (note body + posting) → `keyword-diag.js` (`lastRunDiag_*` entries) → `keyword-triage-core.js` (runs a scan, queue bootstrap, the `__sr*` entry points).

Each module is an IIFE that puts its exports on `globalThis.__srKw` in the browser and on `module.exports` under Node, and takes what it needs through `need(file, names)` at the top, which throws at load (naming the file) if a loader got the order wrong. A module only depends on modules before it; keep it that way. `keyword-triage-core.js` still re-exports the functions the unit tests import, so tests keep requiring it. The new files are LF; the core stays CRLF.

### Feature Split: Core vs Autorun

Each feature is split into two files:

- **`*-core.js`** — pure logic injected into candidate profile pages. Exposes `__sr*` globals. Testable (the test suite imports these directly via `require()`). These files use an IIFE `(function(){ "use strict"; ... })()` and also expose named exports for Node test compatibility.
- **`*-autorun.js`** — state machine that manages the URL queue stored in `chrome.storage.session` (via the `storage-session-shim.js` async wrapper — **not** raw `sessionStorage`). Reads queue state on page load, calls core functions, then navigates to the next URL. Each autorun also has a `runAsParallelWorker()` path that takes precedence when the page is a background worker tab (`srIsParallelWorker` → matching `feature`): it runs the core once, reports `srWorkerDone` to the background, and lets the background navigate the tab to the next URL. The session-queue path is the single-tab fallback.

The popup **Stop** buttons (Cost Assist and Keyword) both call one global `stopEverything()` — it sets `srAbortAll`, tears down any parallel queue, clears both session queues, and closes worker tabs. So Stop kills whatever is running regardless of which tab the popup happens to open on.

### Background Service Worker (`background.js`)

Holds no state in memory that matters: Chrome may stop the service worker at any time (~30s idle), so everything a run needs is in `chrome.storage.session`. Manages:
- Parallel worker tab orchestration (creates/reuses 2–3 worker tabs in their **own unfocused window**, `q.workerWindowId` — so a worker is never the recruiter's active tab; falls back to background tabs in the current window if a window can't open; routes messages between them and the popup via `chrome.runtime.onMessage`). One generic queue drives **both** Keyword and Cost Assist; a `feature: "keyword" | "salary"` discriminator selects the result shape, the saved last-run key (`keywordTriageLastRun` vs `salaryTriageLastRun`), and the done-notification wording. Start messages: `srStartParallelKeywordQueue` / `srStartParallelSalaryQueue`. `srIsParallelWorker` returns `{ active, feature }` so each autorun claims **only** its own feature's worker tabs (both `salary-triage-autorun.js` and `keyword-triage-autorun.js` run on every profile page). Cost Assist needs no resume-focus dance — it reads screening answers from the DOM with no PDF render, so its worker tabs stay hidden.
- **Per-URL leases + watchdog.** The queue is one `srParallelQueue` object in `chrome.storage.session`, with a state per URL: `pending → leased(tabId, leaseUntil) → done | failed`. All reads/writes go through `withQueue()`, which serializes concurrent messages and persists before the next caller. Rules that keep results correct:
  - A tab's `srIsParallelWorker` call is its **check-in**: it marks the lease `started` and starts the work timeout (`WORK_TIMEOUT_MS`: keyword 180s, salary 90s). Before check-in the lease has `START_TIMEOUT_MS` (60s).
  - `srWorkerDone` is accepted **only** from the tab holding a **started** lease. Duplicates, stale tabs and non-workers are ignored, so no URL is recorded twice or under another URL's result.
  - Any resume-focus/capture message from a worker renews its lease, so a slow-but-alive tab is never timed out.
  - The `srQueueWatchdog` alarm (every 30s; alarms wake a stopped service worker, `setTimeout` doesn't) reclaims expired leases: close the tab, retry once (`MAX_ATTEMPTS = 2`), then `failed: "timeout"`. It also abandons runs older than 2h (GDPR).
  - A tab the recruiter closes mid-profile → `failed: "tab_closed"` (not retried); closed between profiles → URL goes back to `pending`.
  - The run finishes when no URL is `pending` or `leased`; results are saved in input order.
  - **Circuit breaker:** `recordOutcome()` runs on every finished URL (`srWorkerDone`, and the watchdog's final `timeout`). `BREAKER_TRIP_COUNT` (3) same-reason failures in a row (`controls_timeout`, `timeout`, or `notes_failed` = matched but note not posted) stop the run like Stop does, save `stoppedReason` + `total` on the last run, and send a "Run stopped early" notification instead of "done". A success resets the streak; `tab_closed` is never recorded (the recruiter's own action). The streak is `q.breaker` on the queue, so it survives an SW restart.
  - **Logged out → pause:** a leased tab landing on `/account/sign-in` (seen via `tabs.onUpdated`, and via check-in from that page) sets `q.pausedSince`. While paused: `launchWorker` opens nothing, the watchdog expires nothing, check-ins from the sign-in page return `active: false`, `srWorkerDone` from a sign-in URL is ignored (covers in-page sign-out mid-profile), and a closed worker tab is requeued rather than `tab_closed`. A leased tab navigating back to any other SR URL resumes the run and gives every in-flight lease a fresh `START_TIMEOUT_MS` window. After `LOGOUT_WAIT_MAX_MS` (15 min) the run stops with `stoppedReason: "logged_out"`. `q.pauseReason` (`"logged_out" | "bot_check"`) says which pause is active.
  - **Bot check → pause:** workers send `botCheck` (DataDome `captcha-delivery.com` iframe or `#ddChallengeBody` present) on check-in and on `srWorkerDone`. Either one calls `pauseForBotCheck`: that lease goes back to not-started (its result, if any, is discarded), `q.pauseTabId` is foregrounded, and a "Paused: bot check" notification asks the recruiter to solve it. While paused: nothing launches or expires, other tabs' check-ins return `active: false`, and a worker finishing a clean profile is closed rather than given a new URL. The pause ends when the challenge tab checks in clean (DataDome reloads it once solved) or the watchdog's `chrome.scripting` probe finds the challenge gone; `resumeAfterBotCheck` then reloads every not-started lease at its pace slot. After `BOT_CHECK_WAIT_MAX_MS` (15 min) → `stoppedReason: "bot_check"`. The extension never touches the challenge itself — keep it that way.
  - **Pace limit:** every profile load (a new worker tab in `launchWorker`, or a reused tab via `scheduleNav`) takes a slot from one shared clock, `q.nextSlotAt`, spaced `jitter(60000 / profilesPerMinute)` apart (default `PROFILES_PER_MINUTE_PER_WORKER` (3) × workers: 2× = 6/min, 3× = 9/min; start-message `profilesPerMinute` capped at 30). A new tab reserves its slot up front (`q.launchAt`, persisted; entries 30s past due are dropped as timers lost to an SW restart) — a launch that only re-checked the clock lost every slot to reused tabs, so 3× ran on 2 tabs. The wait is added to the lease's `leaseUntil` and recorded as the `navDelay` timing. A pending reused-tab navigation keeps `item.navAt` until issued, so the watchdog issues it if an SW restart killed the timer. Queue-mechanics tests run at 30/min (`setup()` default); the pace tests pass `profilesPerMinute: null`.
  - **Preflight:** before a 2×/3× start the popup probes the list tab (password field → logged out, DataDome `captcha-delivery.com` iframe → bot check), asks `srQueueStatus`, and reads the last run; rules live in `run-preflight.js` (tested by `tests/run-preflight.test.js`). It warns only — a second click on the same Go button within 60s starts anyway.
  - A `failed` result is `{ url, error }` with no scan data. Anything that shows results must treat `error` as "not scanned", never as 0 hits / not moved — a recruiter reads "0 hits" as "candidate lacks the skills". The popup's Last run log formats results through `run-summary.js` (`formatKeywordResult`, `summarizeKeywordRun`, `stoppedEarlyLine`, `summarizePhaseTimings`/`formatPhaseTimings`; tested by `tests/run-summary.test.js`), and the done notification counts failures separately.
 - **Phase timings:** keyword results and `lastRunDiag_*` entries carry `timings` (`{ phase: ms }`, in the order the profile went through them). The autorun measures `pageLoad`/`checkIn`/`preStartWait`/`controlsWait` and passes them to the core as `config.__prePhases`; the core's `makePhaseTimer` adds its own phases; the background keeps only finite numbers (`phaseTimings`) and prepends `navDelay` for reused tabs. Use these before changing any wait or sleep. Keyword results keep the worker's `error` (e.g. `controls_timeout`) for the same reason.
  - Tested by `tests/background-queue.test.js`, which runs the real `background.js` in a simulated browser (`tests/helpers/background-harness.js`) with service-worker restarts, hung/closed tabs and duplicate messages. Any change to the queue should add a scenario there.
- Completion notifications (`chrome.notifications`) and audio beep (injected into an active SR tab via `chrome.scripting.executeScript`, since `AudioContext` is unavailable in service workers)
- Tab cleanup on queue completion
- **Resume-render focus handshake** — worker tabs are created `active: false`, but pdf.js does not render in hidden tabs (Chrome pauses `requestAnimationFrame` when `visibilityState === "hidden"`), so the resume text layer never appears and extraction falls back to SR profile chrome. The core requests `srRequestResumeFocus` before extracting the resume; the background `resumeFocus` manager (serialized — one at a time, focus hands off directly between workers) calls `showTabForRender`: activate the tab inside its own window (the worker window — the recruiter's tabs are untouched), and only if a `visibilityState` probe says it is still hidden (window covered) raise that window. On `srReleaseResumeFocus` (or a 25s safety timeout) `giveFocusBack` returns focus to the recruiter's window — but only if the worker window still has it; if they switched tab or window themselves, they are left there. The attachment-capture tab uses the same pair. The core only requests focus when `document.visibilityState !== "visible"`, so single-tab/foreground runs are unaffected.
- **Resume attachment fallback** — when the inline viewer still won't render after the focus handshake + retries, the core clicks the "Resume" attachment (which opens the resume in a new tab) after `srArmResumeCapture`. The background catches that tab by `openerTabId`, foregrounds it so pdf.js renders, extracts text via `chrome.scripting.executeScript`, closes it, and returns the text on `srGetResumeCapture`. Only fires on chrome-only extractions, so it doesn't slow the normal path. Any **other** tab a worker tab opens is closed on `tabs.onCreated`: any tab that worked this run counts (`q.ownTabs`), not only a lease holder, and a finished run's tabs are remembered for 2 min (`srRecentWorkerTabs` in `chrome.storage.session`) so a resume tab that opens just after the run still closes; the run end also sweeps tabs whose opener was a worker. Checks go through `withQueue` so they hold right after an SW restart; tabs opened from non-worker (recruiter) tabs are never closed. Root cause seen live: `ensureResumeTabActive`'s fuzzy "resume" click hit the "Latest Resume" attachment link — it now skips links that open a new page (`target=_blank`, attachment/download hrefs, "Latest Resume"), which also covers single-tab runs where the background can't tell a stray tab from the recruiter's. Tested in `tests/background-queue.test.js` ("tabs opened by worker tabs"). The captured resume text lives **only in-memory** in `resumeCapture.results` (a `Map`), is deleted as soon as the worker reads it via `srGetResumeCapture`, and is never persisted to `chrome.storage`; any unread entry dies with the service worker (~30s idle). Arm entries self-expire after 15s. This in-memory-only lifecycle is intentional for GDPR data-minimization — raw resume text never touches disk here.

### Shadow DOM Traversal

SmartRecruiters uses web components (`spl-button`, `spl-tab`, `sr-link`). All DOM queries go through:
- `walkShadow(node, visitor, visited)` — depth-first traversal that crosses shadow roots
- `queryDeepSelectorAll(root, win, selector)` — shadow-piercing `querySelectorAll`

Never use plain `document.querySelector` for SR elements — it won't find them inside shadow roots.

### SmartRecruiters Selectors (`sr-selectors.js`)

Every SR selector and element id lives in `sr-selectors.js`, so a SmartRecruiters UI change is a one-file fix. Code reads `SR.sel.<name>` (a string, or an array tried in order) and `SR.id.<name>` (for `getElementById` / `findElementByIdDeep`). The cores bind `SR` from `globalThis.__SR`, falling back to `require()` under Node. Functions injected with `chrome.scripting.executeScript({ func })` can't see extension globals, so the caller passes the selector in `args` (popup preflight, Mr Offer `contentFill`, the background's bot-check probe and resume-tab extractor).

The same table drives the DevTools healthcheck: type `__srDomHealthcheck()` on an SR page to see which selectors still match (via `sr-healthcheck-main-world.js`). Plain HTML selectors (`button`, `iframe`, `tr`, `[role="tab"]`) and tag-name comparisons (`tag === "spl-button"`) stay inline. `tests/sr-selectors.test.js` fails if a query call elsewhere uses an SR selector literal, or if a loader drops the file.

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

### Keyword Matching (`keyword-matching.js` + `keyword-expansions.js`)

Two search modes:
- **Keywords mode**: comma-separated terms with abbreviation expansion via `keyword-expansions.js`, prefix wildcard support (`Python*`), ISO list splitting, and token-index bigram matching
- **Boolean mode**: LinkedIn Recruiter syntax parsed into an AST (`parseBooleanQuery` → `evaluateBooleanAst`). Operator precedence: NOT > AND > OR. Implicit AND between adjacent terms. Quoted phrases are single TERM nodes.

### Keyword Notes (`postKeywordHitsToNotes` in `keyword-notes.js`)

Each scanned profile gets a "Note to self", built by `noteBodyLines()` and read top to bottom:

```
Ranel Tartu | SR Profile                ← name | link (must stay a working link)
Current: Engineer at Acme              ← headline under the name ("<title> at <company>"); omitted if none
Location: Tallinn, Estonia (verified)   ← see Candidate Location below
Current CTC: 2–5 L INR                  ← salary screening answers (salaryNoteLines); omitted if none
Expected CTC: 8–11 L INR
                                        ← blank line (only when a line sits above)
Keywords match 2/17:                    ← "Boolean match" for boolean runs; "[PASS] "/"[FAIL] " prefix goes here
                                        ← blank line (only when there are hits)
Scrapy (x3)                             ← one keyword per line, no bullets
WAF (x2)
⚠ Resume PDF not read — partial scan …  ← only when the resume never rendered
```

- Zero hits is one line: `No keyword tagged - Keywords match 0/N`.
- **Salary lines are gated by job country.** At run start the popup calls `__srReadJobCountry` (`readJobCountry` in `keyword-pipeline.js`) on the job page: Job details tab → "Job Country" field → back to Applicants. Only a known, non-EU/EEA country sets `config.salaryNotes` (EU Pay Transparency Directive: no pay-history questions); unknown → off. Then the core opens the Screening tab (`readScreeningTab`) — the answers aren't in the DOM on the Profile tab.
- `displayKeywordLabel()` capitalises keywords **for the note only** (results, diagnostics and the popup keep the matched text): a keyword typed with capitals keeps its spelling; known terms use `KEYWORD_DISPLAY_CASE` (WAF, AWS, PhD, PyTorch, FMCG…, add to it); otherwise each word is capitalised, small words ("and", "of") stay lowercase.
- Two insert paths: a contenteditable rich editor gets `formatNoteHtml` via `execCommand("insertHTML")` so "SR Profile" is a real `<a>`; a `<textarea>` gets `formatNoteText` (plain, bare URL). **The SR Profile link is a hard requirement** — don't switch the rich editor to plain text to fix layout.
- Save confirmation (`noteConfirmMarker`) looks for the `match N/T` text appearing in the notes feed (before vs after Post, via `feedDeltaCount`) — not the keyword list, whose lines may run together in the feed's textContent.
- **Compact lines (CKEditor):** the notes editor is CKEditor 4 (inline, `cke_editable`; Enter = `<p>`, Shift+Enter = `<br>`). Its writer emits `<br />\n`, and SR turns each `\n` into a second `<br>` — that, not our HTML, double-spaced every line (verified live: a single `<br>` per line in the editor became `br,br` in the saved note). Before inserting, the core sends `srCompactNoteBreaks`; the background runs `compactNoteBreaksInPage` in the page's **MAIN** world (`window.CKEDITOR` is invisible to the isolated content script) to `setRules('br', { breakAfterOpen: false, breakAfterClose: false })` on every instance, in the sender's frame. A miss is logged (`could not compact line breaks`) and the note still posts. Keep one `<br>` per line; the only empty lines are the ones before and after `Keywords match N/T:`, and they render as a single blank line now that breaks aren't doubled.

### Candidate Location in Keyword Notes (`location-infer.js` + `location-gazetteer.js`)

Each keyword note starts with a `Location:` line. `resolveCandidateLocation()` tries, in order:
1. **SR profile field** (first item of `sr-candidate-personal-info`'s row) → `(verified)`. Must end in a country or Indian state; phone numbers and job lines ("Engineer at Acme, India") are rejected. A bare gazetteer city in that slot is also `(verified)`.
2. **Resume text** → `(from resume)`. Only the real resume is passed (never SR chrome; see `resumeWasRead`). Contact block first, then the whole text: `Location:`-style labels → "City, [State,] Country" lines → gazetteer scoring (strict: in the header, country confirmed, score ≥ 8) → header city in the phone/email country.
3. **Phone calling code** → country only, `(from phone)`.

It is a port of `ATS-market-reporter/req.py` without spaCy NER or OCR, so every city must be in `location-gazetteer.js`. That file is **generated** by `scripts/build-gazetteer.py` (geonamescache; cities ≥100k, India ≥50k, curated old names like Bangalore/Gurgaon) — regenerate, don't hand-edit. Inference runs in memory on text the scan already has; only the final label goes into the note, and the log records the method, not the location. Tested by `tests/location-infer.test.js`.

### XLSX Parser (`xlsx-mini.js`)

Self-contained async XLSX parser with no external dependencies (no SheetJS, no DOM parser). Supports reading a named sheet (`parseXLSX(buffer, sheetName)`, resolved via `workbook.xml` + rels). Used exclusively by the Mr Offer tab: `popup.js` reads the **"External"** or **"Internal"** sheet of the "New Fitments_India Base Pay" workbook (popup toggle, persisted as `offerSheetName` in `chrome.storage.local`; External is the default), locating each Pay Element row by its column-B label (`BINDINGS_BY_SHEET` maps offer-form field labels → Pay Element labels per sheet) and taking the amount from the "Proposed" column (E). Only offer-form fields marked required (*) are filled. Tested by `tests/xlsx-mini.test.js`.

**The External and Internal tabs are independent calculators** — nothing links them; each has its own WFA Level and Proposed Total Base Pay input cells, and a recruiter may fill only one. The popup keeps the dropped file's bytes in memory (never persisted) so the toggle re-parses without re-dragging, and shows a passive hint when the selected tab looks like an untouched template (≥3 zero/empty fields) while the other tab holds more values. The Internal SmartRecruiters offer form is not yet mapped — `BINDINGS_BY_SHEET.Internal` currently reuses the External bindings; give it its own array once the internal form's field labels are known.

## Lessons

### Some files use CRLF line endings

`keyword-triage-core.js`, `salary-triage-core.js`, `sr-list-autoscroll.js` and both `*-autorun.js` files are CRLF; the rest are LF. A script that reads and rewrites one of them (Python `open()` without `newline=''`, many sed/perl one-liners) silently converts it to LF and the diff shows every line changed. Preserve CRLF when editing it programmatically, and check `git diff --stat` after.

### Prove a regression test against the old code

When fixing a queue/tab bug, run the new `tests/background-queue.test.js` scenario against the committed `background.js` (`git show HEAD:background.js`) and confirm it fails. The first test for the "3× opens only 2 tabs" bug passed on the old code (20s profiles hid the starvation); the bug only shows with fast (~8s) profiles.

### Reported keyword misses: diagnose, don't guess

When a user reports "keyword X missed on profile Y", the matching logic in `keyword-matching.js` is rarely the cause. A keyword miss can come from any of three layers, and they need different evidence:

1. **Matching gap** — the canonical/expansion forms in `KEYWORD_EXPANSIONS` don't cover the variant used in the resume. The regex fallback in `sepFlexiblePatternSource` enforces a `(?![A-Za-z0-9])` boundary, so a single-token keyword won't match a longer compound word that contains it (e.g. `docker` won't match `Dockerfile` without an explicit expansion entry). Fix by adding the compound forms to the expansion table.
2. **Extraction failure** — the resume text never reaches `findKeywordHits`. Common in PDF resumes where pdf.js text layers don't render all pages, or where the resume tab isn't activated in time.
3. **Exclusion over-strip** — `stripExcludedText` removes ALL occurrences of any ≥10-char sidebar phrase from `allText`. If the resume and the job-description sidebar happen to share a long phrase, the resume's keywords inside that phrase are also nuked.

Before changing code: open the popup → **Inspect diagnostics** (the per-profile `lastRunDiag_<timestamp>` entries saved in `chrome.storage.local`, capped at 20). For the failing profile, grep `extractedText` and each `textSources.*` segment for the missed keyword:

- Keyword present in `extractedText` → matching bug. Fix in `keyword-expansions.js` or `findKeywordHits`.
- Keyword present in `textSources.fullPage` but not in `extractedText` → exclusion/strip bug. Fix in `stripExcludedText` or `EXCLUDED_SELECTORS`.
- Keyword absent from every source → extraction bug. Fix in the relevant `get*Text` function or the resume-tab/iframe wait logic.

Do not propose fixes from screenshots alone — unit tests with realistic text usually pass even when production fails, because the bug is upstream of matching. The diagnostic capture (added in `runKeywordTriageWithDoc` / `runBooleanTriageWithDoc`) exists specifically to remove that ambiguity.
