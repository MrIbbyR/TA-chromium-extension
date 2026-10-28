# NIQ TA Helper — Chrome Extension

A Manifest V3 Chrome extension that automates repetitive Talent Acquisition workflows inside SmartRecruiters. Built for NIQ associates with no external dependencies, no build step, and no npm.

---

## Features

### Cntrl + F Keyword Skills Tagging
Tag Smartrecruiters profiles with user defined keywords automating a recruiters cntrl +F  
Boolean tab where user can paste a search and tag keywords which hit the profiles 

### Cost Assist — Salary Budget Screening
Specify salary range within fields and prospects who fit in that range auto-advances in-budget candidates with **Move Forward**.

### Offer Letter Auto-Fill
Drag & drop excel datapoint into SmartRecruiters offer page. Supports annual ↔ monthly derivation, fuzzy label matching, and Angular/React-compatible input dispatch.

| Mode | Description |
|---|---|
| **Keywords** | Comma-separated terms with abbreviation expansion (`ML` → `machine learning`), prefix wildcards (`Python*`), and ISO list splitting (`ISO 9001, 45001`) |
| **Boolean** | LinkedIn Recruiter syntax: `(Python OR Java) AND "machine learning" AND NOT intern` |

Supports **single-tab** (sequential) and **parallel** (2–3 worker tabs) execution. Results optionally posted to candidate notes.

---

## Installation

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder.
5. The NIQ TA Helper icon will appear in your toolbar.

> The extension only activates on `*.smartrecruiters.com` pages.

---

## Usage

### Offer 

1. Navigate to a SmartRecruiters offer form.
2. Click the extension icon and open the **Mr Offer** tab.
3. Drag and drop your `.xlsx` compensation template onto the drop zone (or click to browse).
4. Review the field preview table.
5. Click **Fill Offer** — the extension injects values into all matching form fields.

### Cost Assist

1. On a SmartRecruiters candidate list, use the **autoscroll** to harvest profile URLs (the extension scrolls the virtual list and collects links automatically).
2. Open the extension popup → **Cost Assist** tab.
3. Set your **Min** and **Max** salary budget.
4. Click **Start Queue** — the extension navigates each profile, reads the salary answer, and logs the result.

### Cntrl + F Search

1. Harvest candidate URLs from the list view (same autoscroll as above).
2. Open the extension popup → **Keyword Search** tab.
3. Choose **Keywords** or **Boolean** mode.
   - Keywords: enter comma-separated terms (e.g. `Python, ML, AWS`)
   - Boolean: enter a boolean query (e.g. `(Python OR Java) AND "machine learning"`)
4. Set **Min Hits** (keywords mode), number of **Workers**, and toggle **Post to Notes** if you want results saved on the candidate profile.
5. Click **Start** — results stream into the log panel in real time.

---

## File Structure

```
manifest.json               Extension manifest (MV3)
popup.html / popup.js       Three-tab UI (Mr Offer / Cost Assist / Keyword Search)
background.js               Service worker: parallel keyword worker orchestration
sr-list-autoscroll.js       Virtual list scroller; harvests candidate profile URLs
salary-triage-core.js       Salary extraction + budget comparison logic
salary-triage-autorun.js    URL queue state machine for Cost Assist
sr-selectors.js             Every SmartRecruiters selector + DevTools healthcheck
keyword-triage-core.js      Keyword scan orchestration (runs the keyword-*.js modules below)
keyword-dom.js              Shadow-piercing DOM queries and click helpers
keyword-matching.js         Keyword normalization, matching, boolean parser (no DOM)
keyword-extract.js          Resume / header / location / screening text from the profile
keyword-pipeline.js         Move Forward + applicant-list URL harvesting
keyword-notes.js            Builds and posts the keyword "Note to self"
keyword-diag.js             Per-profile diagnostics (Inspect diagnostics)
keyword-triage-autorun.js   Parallel worker state machine + URL queue
keyword-expansions.js       Shared abbreviation/synonym expansion table
xlsx-mini.js                Self-contained async XLSX parser (no SheetJS, no DOM parser)
icon.png                    Extension icon
NIQ logo.png                Header logo in popup UI
```

---

## Technical Notes

- **No remote code**: no CDN, no `eval`, no `new Function`. MV3 compliant.
- **No build step**: source files are shipped directly.
- **Shadow DOM**: all DOM access uses `walkShadow` / `queryDeepSelectorAll` utilities to pierce SmartRecruiters custom elements (`spl-button`, `spl-tab`, `sr-link`).
- **Anti-detection**: all navigation timing uses `jitter(baseMs)` (±35% randomisation). Worker tabs are reused across URLs rather than opened fresh each time.
- **Service worker**: stateless by design. Only the active parallel keyword queue is held in memory; all other config is read from `chrome.storage.local` or `sessionStorage` per message.

---

## Storage

| Store | Key | Feature |
|---|---|---|
| `chrome.storage.local` | `usageCount` | Mr Offer usage counter |
| `chrome.storage.local` | `salaryTriageMax/Min` | Cost Assist settings |
| `chrome.storage.local` | `kwTriageKeywords/MinHits/PostToNotes/DryRun/Mode/BooleanQuery/Workers` | Keyword Search settings |
| `chrome.storage.local` | `salaryTriageLastRun`, `keywordTriageLastRun` | Last run results |
| `chrome.storage.local` | `srParallelWorkerConfig`, `srParallelWorkerActive` | Parallel worker state |
| `sessionStorage` | `sr_ext_salary_triage_v1` | Cost Assist URL queue |
| `sessionStorage` | `sr_ext_keyword_triage_v1` | Keyword Search URL queue |
