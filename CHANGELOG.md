# Changelog

All notable changes to NIQ TA Helper. Versions follow [Semantic Versioning](https://semver.org/):
MAJOR for breaking changes to user workflow or stored data, MINOR for new features, PATCH for fixes.

The top `## [x.y.z]` heading must match `"version"` in `manifest.json` — `tests/release.test.js` enforces this.

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
