# Changelog

All notable changes to NIQ TA Helper. Versions follow [Semantic Versioning](https://semver.org/):
MAJOR for breaking changes to user workflow or stored data, MINOR for new features, PATCH for fixes.

The top `## [x.y.z]` heading must match `"version"` in `manifest.json` — `tests/release.test.js` enforces this.

## [2.4.0] - 2026-09-23

Reliability rework of the parallel (2×/3×) queue used by Keyword Search and Cost Assist.

### Fixed
- Chrome restarting the background service worker mid-run no longer loses track of in-flight profiles. Previously results could be saved with no URL, the run could finish early and drop a result, or a worker tab could sit idle forever.
- A duplicate "done" message from a worker could record a profile as scanned that was never processed, carrying another profile's result.
- A worker tab that hangs (bot-check page, page that never loads) no longer stalls the run forever. It is closed after a timeout, retried once, then reported as `timeout`.
- A worker tab closed by the recruiter between profiles no longer loses the next profile; it goes back in the queue.
- Resume tabs ("latest-resume") opened by parallel worker tabs are now closed. Before, any resume tab a worker opened outside the armed attachment fallback stayed open, leaving several tabs to close by hand after each run. Tabs opened from the recruiter's own tabs are never touched.
- A profile that could not be scanned (worker tab closed, or timed out) no longer shows as "0 hits" in the popup's Last run log, where it looked like a candidate with none of the keywords. It now shows `⚠ not scanned — tab closed / timed out`, with a count to re-run, and the done notification counts it apart ("… out of 20 scanned. 1 could not be scanned").

### Changed
- Queue state moved from `chrome.storage.local` to `chrome.storage.session` (in-memory, cleared on browser close), with a state per URL (pending / leased / done / failed). Leftover keys from older versions are removed on startup.
- Parallel run results are saved in the order of the candidate list.
- New `alarms` permission for the queue watchdog (no install warning).

### Added
- `run-summary.js`: the popup's Last run formatting, moved out of `popup.js` so it can be tested (`tests/run-summary.test.js`).
- `tests/background-queue.test.js`: runs the real `background.js` in a simulated browser with service-worker restarts, hung/closed tabs and duplicate messages.

## [2.3.0] - 2026-09-23

### Added
- Version label in the popup header (read from `manifest.json`).
- Parallel 2×/3× Cost Assist workers and a global **Stop** that halts any running queue.
- External/Internal fitment sheet toggle in Mr Offer.
- Keyword/Boolean search: accurate Ctrl+F hit counts, reliable note-save confirmation, resume-load retries for slow PDFs.
- Per-profile keyword diagnostics (`lastRunDiag_*`, 7-day retention) and a Playwright e2e suite.
- CI: unit tests, e2e tests and a packaged extension zip on every push.

### Changed
- Queue state moved to `chrome.storage.session` (in-memory, extension-isolated) for GDPR data minimization.

### Removed
- On-disk run history (IndexedDB `run-history.js`) for GDPR compliance.

### Fixed
- Silent session-storage write denial that stalled Cost Assist queues (`setAccessLevel` Promise handling).
- Session shim missing on tabs opened before an extension reload.
- Double-posting of candidate notes.

## [2.2.0] - 2026-05-13

### Fixed
- Resilience, deduplication and DataDome jitter gaps.

Note: `manifest.json` still said `2.0.0` through 2.2.0. 2.3.0 is the first release where the manifest version is kept in sync.
