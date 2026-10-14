# Changelog

All notable changes to NIQ TA Helper. Versions follow [Semantic Versioning](https://semver.org/):
MAJOR for breaking changes to user workflow or stored data, MINOR for new features, PATCH for fixes.

The top `## [x.y.z]` heading must match `"version"` in `manifest.json` — `tests/release.test.js` enforces this.

## [2.6.0] - 2026-10-14

Keyword notes are easier to read and say where the candidate is; runs stay out of your way and really use 3 tabs at 3×.

### Fixed
- **Keyword notes were double-spaced.** SmartRecruiters' notes editor added an extra blank line after every line of the note. Notes now post as compact lines, with the SR Profile link unchanged.
- **Resume tabs left open after a run.** The resume-tab search could click the "Latest Resume" attachment link, which opens the file in a new tab; it now skips links that open a new page. Any tab a worker opens is closed even if it appears after that worker finished or just after the run ended, and the run end sweeps up any that are left.
- **Runs no longer take over your tabs.** Worker tabs open in their own window instead of yours. To render a resume, a worker tab is activated inside that window, and the window is only raised if the page would otherwise stay hidden. Focus goes back to your window afterwards, unless you've moved to another tab or window yourself, in which case you're left where you are. Before, the run switched your window to worker tabs and back to whatever tab was active when it first did so.
- **3× ran on only 2 worker tabs.** With quick profiles, the two busy tabs took every load slot under the pace limit, so the third tab never opened and 3× was no faster than 2×. A new tab now reserves its slot like a reused tab does.
- **An unreadable resume no longer stalls for 24 extra seconds.** When the inline viewer gave no text, the attachment fallback clicked a "resume" link and then waited its full 24 seconds even if the click opened nothing (seen on a profile whose upload was a cover letter), holding the front tab the whole time. It now gives up 6 seconds after a click that opens no tab. The diagnostics for such a profile also record what the resume tab held: PDF page, canvas, text-span and frame counts, plus attachment kinds and file types, with no names or text.

### Changed
- **Pace limit scales with workers:** 3 profiles a minute per worker, so 2× stays at about 6 a minute and 3× runs at about 9 a minute (previously 6 for both). 3× is now meaningfully faster, at a higher request rate to SmartRecruiters.
- **Keyword notes are a top-to-bottom list.** Under the name | SR Profile header, the note now shows the candidate's location (e.g. "Location: Chennai, India (verified)"), then "Matched N/T:" and a blank line, then one keyword per line, capitalised ("Scrapy (x3)", "Data Acquisition", "WAF"; anything you typed with capitals keeps your spelling), where it used to be a single comma-separated line. Zero hits is still one "No keyword tagged - Matched 0/N" line. Note-save confirmation now looks for the "Matched N/T" text in the notes feed.
- **Candidate location in keyword notes.** Taken from the profile's location field when set, marked "(verified)". Otherwise it is inferred from the resume text the scan already read (labelled lines like "Location:", "City, State, Country" lines, then cities scored by position and country), marked "(from resume)", or as a last resort the country from the phone's calling code, marked "(from phone)". Cities are checked against a bundled city list (`location-gazetteer.js`, built from geonames), so job titles, skills and words like "Mobile" or "Reading" aren't mistaken for places. Nothing new is stored. Ported from the ATS market reporter's location logic, without its NER/OCR steps.

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
