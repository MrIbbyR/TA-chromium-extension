# Roadmap

Future direction for NIQ TA Helper. Written 2026-10-14, after v2.6.0.

## Tech stack: stay a Chrome extension

The tool began as a Python script and was ported to a JS extension. The extension is the right shape for what it does, and Python or Go wouldn't make it faster or more reliable:

- **Runs in the recruiter's own SmartRecruiters session.** No credentials, SSO or separate browser profile to handle.
- **Friendlier to DataDome.** A real Chrome window paced at 6–9 profiles/min looks human. Playwright/Selenium (Python) drive Chrome through automation hooks that bot detection is built to spot.
- **GDPR fit.** Candidate data stays in browser memory; no server holds resumes.
- **Zero-install distribution.** One zip, no Python runtime, no admin rights.
- **Speed is bound by page loads and the deliberate pace limit**, not CPU, so Go's performance buys nothing.

## Options, in priority order

### 1. Code quality inside the current stack (next)
- **`// @ts-check` + JSDoc types**, with `tsc --noEmit` in CI — started 2026-10-15: `tests/typecheck/` (TypeScript 7, strict), CI job, `keyword-dom.js` + `keyword-matching.js` checked. Next: the other `keyword-*.js` modules, then `sr-selectors.js`, `run-summary.js`, `run-preflight.js`.
- ~~**Split `keyword-triage-core.js`**~~ — done 2026-10-15: `keyword-dom/matching/extract/pipeline/notes/diag.js` (135–970 lines each), core down to ~900 lines of scan orchestration.
- ~~**All SR page selectors in `sr-selectors.js`**~~ — done 2026-10-15; an SR UI change is now a one-file fix, guarded by `tests/sr-selectors.test.js`. Still to do: a live healthcheck pass with Claude in Chrome.

### 2. SmartRecruiters API (strategic — needs approval)
Ask NIQ's SR admin whether an API key can be issued. With API access, a Python service could read candidates and post notes directly. That removes whole classes of bugs: shadow DOM traversal, CKEditor quirks (the double-spaced notes), missing Notes tabs, the resume viewer not rendering, and bot checks.

Costs: IT/SR approval, somewhere to host it, and a GDPR review, because candidate data would pass through a server. This is the only option that changes how well the tool works.

### 3. Heavier text analysis (only if location misses become a complaint)
The location detection port dropped spaCy NER and OCR from `ATS-market-reporter/req.py`. Options:
- Run an NER model in the browser via Transformers.js (no install, larger extension).
- A local Python helper over Chrome native messaging (full spaCy, but an install on every laptop).

### Keep doing
Python for offline tooling (`scripts/build-gazetteer.py`), JavaScript for everything that runs in the browser.
