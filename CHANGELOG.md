# Changelog

All notable changes to NIQ TA Helper. Versions follow [Semantic Versioning](https://semver.org/):
MAJOR for breaking changes to user workflow or stored data, MINOR for new features, PATCH for fixes.

The top `## [x.y.z]` heading must match `"version"` in `manifest.json` — `tests/release.test.js` enforces this.

## [2.5.0] - 2026-09-24

Run health for the parallel (2×/3×) queue: stop runs that are failing, and warn before starting one that would.

### Added
- **Circuit breaker.** A run stops by itself after 3 profiles in a row fail for the same reason: the page never finished loading, the tab hung, or the note didn't post. The results so far are saved, and a "Run stopped early" notification plus the popup's Last run log say why and how far it got. A tab the recruiter closes never counts. The streak survives a service-worker restart.
- **Pause on logout.** If SmartRecruiters logs you out mid-run (every tab goes to `/account/sign-in`), the run pauses instead of failing profiles: no new tabs, nothing times out, and one "Paused: logged out" notification. It carries on as soon as you log back in. If nobody logs back in within 15 minutes, it stops with the reason "logged out of SmartRecruiters". A worker tab closed while logged out goes back in the queue.
- **Pace limit.** A 2×/3× run loads at most about 6 profiles a minute in total, however many worker tabs it uses (jittered, like every other delay). More workers still hide slow pages, but no longer multiply the request rate SmartRecruiters' bot protection sees. The popup's run log shows the pace; the start message accepts `profilesPerMinute` (capped at 30).
- **Pause on bot check.** If DataDome's challenge appears in a worker tab (on a page load or over a page mid-profile), the run pauses: that tab is brought to the front with a "Paused: bot check" notification, nothing new loads, nothing times out, and a result read from under the challenge is discarded. Once you solve it the run continues and reloads the affected profiles. Not solved within 15 minutes → it stops with the reason "SmartRecruiters bot check not solved". The extension never interacts with the challenge itself.
- **Preflight check** before a 2×/3× run (Keyword and Cost Assist). It warns if SmartRecruiters looks logged out, is showing a bot check, if a run is already in progress (starting would cancel it), or if the last run was stopped by the breaker in the past 30 minutes. It only warns: click the same Go button again within 60s to start anyway.
- `srQueueStatus` background message (is a run in progress?).
- **Per-phase timings for Keyword runs.** Each profile records how long each step took (pause before the profile, page load, fixed wait, SR controls, resume render and retry, profile tab, text processing, match, opening notes, posting the note). The Last run log shows median and p90 per profile and each step's share of the time; Inspect diagnostics shows the per-profile breakdown. Durations only — no candidate data.

### Fixed
- **Keyword search waited 12s for every resume, even after it had loaded.** The "is the resume ready?" check read text that also included SR's summary sidebar, so it always looked like sidebar text and the wait ran to its timeout. It now also watches the PDF's own text and continues about a second after the last page appears. In a 23-profile run this was ~12s of every successful profile's ~15s.
- Per-profile diagnostics could exceed their 20-entry cap after a parallel run (seen: 22). A worker tab closed right after its last profile could die before trimming the list. The background now trims when a run finishes, and the popup enforces the cap (not just the 7-day expiry) when it opens.
- A run stopped because the logout pause ran out was described as "3 profiles in a row" failing. It now says "Stopped: logged out of SmartRecruiters for 15 minutes".
- A keyword profile whose page never finished loading (`controls_timeout`) was shown as "0 hits". It now shows as `⚠ not scanned — page never finished loading`.

### Changed
- CI: actions bumped to checkout/setup-node/upload-artifact v7 and download-artifact v8 (Node 20 actions are deprecated). Unit tests now run on Node 22 and 24, and runners are pinned to `ubuntu-24.04` so the Ubuntu 26 migration is a deliberate change.

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
