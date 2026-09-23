// popup.js — NIQ TA Helper: Offer + Cost assist + Keyword/Boolean
// Uses xlsx-mini.js (local, self-contained — no CDN required).

// ── GDPR storage limitation (Art. 5(1)(e)): lazy-GC of expired local PII ──
// Runs on every popup open (the recruiter's normal entry point), so no scheduler is
// needed. Diagnostics expire after 7 days; last-run result snapshots after 24 hours.
(async function purgeExpiredRetention() {
  try {
    if (!(typeof chrome !== "undefined" && chrome.storage && chrome.storage.local)) return;
    const DIAG_PREFIX = "lastRunDiag_";
    const DIAG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const LASTRUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const all = await chrome.storage.local.get(null);
    const toRemove = [];
    for (const k of Object.keys(all)) {
      if (k.indexOf(DIAG_PREFIX) === 0) {
        const ts = parseInt(k.slice(DIAG_PREFIX.length), 10) || 0;
        if (ts < now - DIAG_MAX_AGE_MS) toRemove.push(k);
      }
    }
    for (const k of ["keywordTriageLastRun", "salaryTriageLastRun"]) {
      const rec = all[k];
      if (rec && typeof rec.finishedAt === "number" && rec.finishedAt < now - LASTRUN_MAX_AGE_MS) {
        toRemove.push(k);
      }
    }
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
  } catch (_) {}
})();

// ── Version label: read from manifest.json so it can never drift from what's installed ──
(function showAppVersion() {
  try {
    const el = document.getElementById("appVersion");
    if (el) el.textContent = "v" + chrome.runtime.getManifest().version;
  } catch (_) {}
})();

// "New Fitments_India Base Pay" workbook: offer numbers live on the "External"
// sheet (external hires) or the "Internal" sheet (internal moves) — the two
// tabs are independent calculators with their own input cells, so the popup
// lets the recruiter pick which one to read. Each sheet has one row per Pay
// Element (labels in column B), amounts in the "Proposed" column (E). Rows are
// located by their column-B label rather than fixed addresses, so yearly
// layout shuffles (and the Internal tab's extra NPS/Superannuation rows)
// don't silently break the mapping.
// Only offer-form fields marked required (*) are filled.
const OFFER_SHEETS = ["External", "Internal"];
const PROPOSED_COL = "E";

const BINDINGS = [
  { label: "Total Compensation",                        element: "Total Compensation" },
  { label: "Basic Salary",                              element: "Basic Salary" },
  { label: "General Allowance",                         element: "General Allowance" },
  { label: "HRA",                                       element: "HRA" },
  { label: "Transport Allowance",                       element: "Transport Allowance" },
  { label: "Communication Allowance",                   element: "Communication Allowance" },
  { label: "Upskilling Allowance",                      element: "Upskilling Allowance" },
  { label: "Total Base Salary (Annual)",                element: "Total Base Pay" },
  { label: "Employer's Contribution to Provident Fund", element: "Employer's Contribution to PF" },
  { label: "Statutory Bonus",                           element: "Statutory Bonus (Advance)" },
  { label: "Annual Bonus",                              element: "Annual Incentive Plan" },
  { label: "Annual Salary",                             element: "Total Base Pay" },
];

// The internal-move SmartRecruiters offer form has not been mapped yet — it
// reuses the external bindings for now. When the internal form's field labels
// are known, give Internal its own array here.
const BINDINGS_BY_SHEET = {
  External: BINDINGS,
  Internal: BINDINGS,
};

// ── State ──
let parsedValues = {};   // { UI label: formattedString }
let offerSheet = "External";  // which workbook tab to read (persisted)
let loadedBuffer = null;      // ArrayBuffer of the dropped file, in-memory only,
                              // so switching sheets re-parses without re-dragging
function activeBindings() {
  return BINDINGS_BY_SHEET[offerSheet] || BINDINGS;
}

// ── Usage tracking (local only; for rollout analytics add a backend ping) ──
async function loadUsageCount() {
  const { usageCount = 0 } = await chrome.storage.local.get("usageCount");
  const el = document.getElementById("usageNum");
  if (el) el.textContent = usageCount;
}
async function incrementUsageCount() {
  const { usageCount = 0 } = await chrome.storage.local.get("usageCount");
  const next = usageCount + 1;
  await chrome.storage.local.set({ usageCount: next });
  const el = document.getElementById("usageNum");
  if (el) el.textContent = next;
}

// ── DOM refs ──
const dropZone     = document.getElementById("dropZone");
const fileInput    = document.getElementById("fileInput");
const fileLoaded   = document.getElementById("fileLoaded");
const fileName     = document.getElementById("fileName");
const fieldCount   = document.getElementById("fieldCount");
const fileClear    = document.getElementById("fileClear");
const preview      = document.getElementById("preview");
const previewTable = document.getElementById("previewTable");
const runBtn       = document.getElementById("runBtn");
const statusBox    = document.getElementById("statusBox");
const statusDot    = document.getElementById("statusDot");
const statusLabel  = document.getElementById("statusLabel");
const logEl        = document.getElementById("log");
const summaryEl    = document.getElementById("summary");
const sumFilled    = document.getElementById("sumFilled");
const sumCurrency  = document.getElementById("sumCurrency");
const sumCurrencyPill = document.getElementById("sumCurrencyPill");
const sumErrors    = document.getElementById("sumErrors");
const sumErrorPill = document.getElementById("sumErrorPill");

const tabOffer   = document.getElementById("tabOffer");
const tabSalary  = document.getElementById("tabSalary");
const tabKeyword = document.getElementById("tabKeyword");
const panelOffer   = document.getElementById("panel-offer");
const panelSalary  = document.getElementById("panel-salary");
const panelKeyword = document.getElementById("panel-keyword");

const salaryMax       = document.getElementById("salaryMax");
const salaryMin       = document.getElementById("salaryMin");
const salaryWait      = document.getElementById("salaryWait");
const salaryDryRun    = document.getElementById("salaryDryRun");
const btnSalaryGo2x     = document.getElementById("btnSalaryGo2x");
const btnSalaryGo3x     = document.getElementById("btnSalaryGo3x");
const btnSalaryStop     = document.getElementById("btnSalaryStop");
const salaryStatusBox   = document.getElementById("salaryStatusBox");
const salaryStatusDot   = document.getElementById("salaryStatusDot");
const salaryStatusLabel = document.getElementById("salaryStatusLabel");
const salaryLogEl       = document.getElementById("salaryLog");

const SALARY_STORAGE_KEYS = [
  "salaryTriageMax",
  "salaryTriageMin",
  "salaryTriageWait",
  "salaryTriageDryRun",
];

// ── Tabs ──
function showPanel(which) {
  tabOffer.classList.toggle("active", which === "offer");
  tabSalary.classList.toggle("active", which === "salary");
  tabKeyword.classList.toggle("active", which === "keyword");
  panelOffer.classList.toggle("visible", which === "offer");
  panelSalary.classList.toggle("visible", which === "salary");
  panelKeyword.classList.toggle("visible", which === "keyword");
}

tabOffer.addEventListener("click", () => showPanel("offer"));
tabSalary.addEventListener("click", () => showPanel("salary"));
tabKeyword.addEventListener("click", () => showPanel("keyword"));

// ── Cost assist settings (chrome.storage) ──
async function loadSalarySettings() {
  const s = await chrome.storage.local.get(SALARY_STORAGE_KEYS);
  if (s.salaryTriageMax != null) salaryMax.value = String(s.salaryTriageMax);
  if (s.salaryTriageMin != null) salaryMin.value = String(s.salaryTriageMin);
  if (s.salaryTriageWait != null) salaryWait.value = String(s.salaryTriageWait);
  if (s.salaryTriageDryRun === true) salaryDryRun.checked = true;
}

async function saveSalarySettings() {
  await chrome.storage.local.set({
    salaryTriageMax: salaryMax.value.trim(),
    salaryTriageMin: salaryMin.value.trim(),
    salaryTriageWait: salaryWait.value.trim(),
    salaryTriageDryRun: salaryDryRun.checked,
  });
}

/** Same rules as salary-triage-core parseSalaryNumber / budget (Indian commas, 35L, ranges). */
function parseCostAssistBudgetInput(raw) {
  const s0 = String(raw ?? "").trim();
  if (!s0) return NaN;
  const lower = s0.toLowerCase();
  let wordMult = 1;
  if (/\bcr(?:ore)?s?\b/.test(lower)) wordMult = 1e7;
  else if (/\blakhs?\b|\blacs?\b/.test(lower)) wordMult = 1e5;
  else if (/\bmillion\b|\bmn\b/.test(lower)) wordMult = 1e6;
  let work = s0.replace(/\u2013|\u2014/g, "-").replace(/(\d+(?:\.\d+)?)\s*[lL]\b/g, function (_, n) {
    return String(Math.round(parseFloat(n) * 1e5));
  });
  work = work
    .replace(/\b(eur|euros?|€|usd|\$|gbp|£|inr|₹|myr|rm|bgn|leva|ctc)\b/gi, " ")
    .replace(/\blakhs?\b|\blacs?\b/gi, " ")
    .replace(/\bcr(?:ore)?s?\b/gi, " ")
    .replace(/\bmillion\b|\bmn\b/gi, " ");
  work = work.replace(/,/g, "");
  let kMult = 1;
  if (/\d\s*k\b/i.test(lower) || /\d+k\b/i.test(lower.replace(/,/g, ""))) kMult = 1000;
  const nums = [];
  const re = /(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(work))) {
    const v = parseFloat(m[1]);
    if (isFinite(v)) nums.push(v);
  }
  if (!nums.length) return NaN;
  const rangeLike =
    /\d+\s*[-–—]\s*\d+/.test(s0) || /\d+\s+to\s+\d+/i.test(lower) || /\bbetween\b/i.test(lower);
  if (nums.length >= 2 && rangeLike) return Math.max.apply(null, nums) * wordMult * kMult;
  return nums[nums.length - 1] * wordMult * kMult;
}

function readSalaryConfig() {
  return {
    maxSalary: salaryMax.value.trim(),
    minSalary: salaryMin.value.trim(),
    dryRun: salaryDryRun.checked,
    screeningWaitMs: salaryWait.value.trim() === "" ? 600 : parseInt(salaryWait.value, 10),
  };
}

[salaryMax, salaryMin, salaryWait, salaryDryRun].forEach((el) => {
  if (!el) return;
  el.addEventListener("change", () => saveSalarySettings().catch(() => {}));
});

function salaryLog(icon, msg) {
  const line = document.createElement("div");
  line.className = "log-line";
  const cls = icon === "✓" ? "tick" : icon === "✗" ? "cross" : "wait";
  const iconSpan = document.createElement("span");
  iconSpan.className = cls;
  iconSpan.textContent = icon;
  const msgSpan = document.createElement("span");
  msgSpan.className = "msg";
  msgSpan.textContent = msg;
  line.appendChild(iconSpan);
  line.appendChild(msgSpan);
  salaryLogEl.appendChild(line);
  salaryLogEl.scrollTop = salaryLogEl.scrollHeight;
}

function setSalaryStatus(state, label) {
  salaryStatusDot.className = "status-dot " + state;
  salaryStatusLabel.textContent = label;
}

async function getSmartRecruitersTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  const u = tab.url || "";
  if (!/smartrecruiters\.com/i.test(u)) {
    return null;
  }
  return tab;
}

async function ensureSalaryCore(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    // storage-session-shim.js first: on a tab that predates an extension reload,
    // declared content scripts aren't re-injected, so __srSessionSet would be
    // missing and the queue seed would fail with "shim not loaded".
    files: ["storage-session-shim.js", "sr-list-autoscroll.js", "salary-triage-core.js"],
  });
}

// ── Number formatter (mirrors Python _fmt_num) ──
function fmtNum(v) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") return String(Math.round(v));
  const s = String(v).trim().replace(/,/g, "");
  const n = parseFloat(s);
  if (!isNaN(n)) return String(Math.round(n));
  return s;
}

// ── Parse Excel file using local xlsx-mini.js ──
function normElement(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function parseExcel(arrayBuffer, sheetName) {
  const cells = await window.XLSXMini.parseXLSX(arrayBuffer, sheetName);

  // Column B holds the Pay Element labels; map normalized label → row number
  const rowByElement = {};
  for (const [ref, val] of Object.entries(cells)) {
    const m = /^B(\d+)$/.exec(ref);
    if (!m) continue;
    const key = normElement(val);
    if (key && !(key in rowByElement)) rowByElement[key] = m[1];
  }

  const values = {};  // { UI label: formattedString }
  for (const b of (BINDINGS_BY_SHEET[sheetName] || BINDINGS)) {
    const row = rowByElement[normElement(b.element)];
    const raw = row !== undefined ? cells[PROPOSED_COL + row] : "";
    values[b.label] = (raw !== undefined && raw !== "") ? fmtNum(raw) : "";
  }
  return values;
}

// ── Build preview table ──
function buildPreview(values) {
  previewTable.innerHTML = "";
  let filled = 0;
  for (const b of activeBindings()) {
    const v = values[b.label] || "";
    if (v) filled++;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td title="${b.label}">${b.label}</td>
      <td class="${v ? "" : "empty"}">${v || "—"}</td>
    `;
    previewTable.appendChild(tr);
  }
  return filled;
}

// ── Sheet toggle (External / Internal fitment) ──
const sheetSeg      = document.getElementById("sheetSeg");
const sheetHint     = document.getElementById("sheetHint");
const dropSheetName = document.getElementById("dropSheetName");

function updateSheetToggleUI() {
  for (const btn of sheetSeg.querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.sheet === offerSheet);
  }
  dropSheetName.textContent = offerSheet;
}

async function loadOfferSheetSetting() {
  const { offerSheetName } = await chrome.storage.local.get("offerSheetName");
  if (OFFER_SHEETS.includes(offerSheetName)) offerSheet = offerSheetName;
  updateSheetToggleUI();
}

async function setOfferSheet(sheet) {
  if (!OFFER_SHEETS.includes(sheet) || sheet === offerSheet) return;
  const prev = offerSheet;
  offerSheet = sheet;
  updateSheetToggleUI();
  chrome.storage.local.set({ offerSheetName: sheet });
  if (!loadedBuffer) return;
  try {
    await renderLoadedFile();
  } catch (err) {
    // e.g. this workbook has no "Internal" tab — revert and surface the error
    offerSheet = prev;
    updateSheetToggleUI();
    chrome.storage.local.set({ offerSheetName: prev });
    try { await renderLoadedFile(); } catch (_) {}
    sheetHint.textContent = "✗ " + err.message;
    sheetHint.classList.add("visible");
    console.error("Sheet switch failed:", err);
  }
}

sheetSeg.addEventListener("click", e => {
  const sheet = e.target?.dataset?.sheet;
  if (sheet) setOfferSheet(sheet);
});

// Count fields that hold a real amount ("" and "0" both mean unfilled here —
// an untouched fitment calculator legitimately computes 0 for the allowances)
function countFilledValues(values) {
  return Object.values(values).filter(v => v && v !== "0").length;
}

// Warn when the selected tab looks like an untouched template while the other
// tab holds the actual fitment (recruiter filled Internal but popup reads
// External, or vice versa). Passive: never switches on its own.
async function updateSheetHint() {
  sheetHint.classList.remove("visible");
  sheetHint.textContent = "";
  if (!loadedBuffer) return;
  const other = offerSheet === "External" ? "Internal" : "External";
  let otherValues;
  try {
    otherValues = await parseExcel(loadedBuffer, other);
  } catch (_) {
    return; // workbook has no other tab — nothing to compare
  }
  const curFilled   = countFilledValues(parsedValues);
  const curEmpty    = Object.keys(parsedValues).length - curFilled;
  const otherFilled = countFilledValues(otherValues);
  if (curEmpty >= 3 && otherFilled > curFilled) {
    sheetHint.textContent =
      `⚠ The "${offerSheet}" tab looks unfilled (${curFilled} non-zero fields) — ` +
      `the "${other}" tab has ${otherFilled}. Is this an ${other.toLowerCase()} fitment?`;
    const btn = document.createElement("button");
    btn.textContent = `Switch to ${other}`;
    btn.addEventListener("click", () => setOfferSheet(other));
    sheetHint.appendChild(btn);
    sheetHint.classList.add("visible");
  }
}

// ── Handle file ──
// Parses the in-memory workbook against the currently selected sheet and
// refreshes the preview; called on file drop and on sheet toggle.
async function renderLoadedFile() {
  const values = await parseExcel(loadedBuffer, offerSheet);
  parsedValues = values;
  buildPreview(values);
  const nonEmpty = Object.values(values).filter(Boolean).length;
  fieldCount.textContent =
    `${nonEmpty} of ${activeBindings().length} fields have values · "${offerSheet}" tab`;
  await updateSheetHint();
}

function handleFile(file) {
  if (!file) return;

  const label = dropZone.querySelector(".drop-label");
  label.textContent = "Reading…";

  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      loadedBuffer = e.target.result;
      await renderLoadedFile();

      dropZone.style.display = "none";
      fileLoaded.classList.add("visible");
      fileName.textContent = file.name;
      preview.classList.add("visible");
      runBtn.classList.add("visible");
      document.getElementById("currencyNote")?.classList.add("visible");
      statusBox.classList.remove("visible");
      summaryEl.classList.remove("visible");
      logEl.innerHTML = "";
    } catch(err) {
      loadedBuffer = null;
      label.textContent = "Drop Excel file here";
      // Show error visibly in the drop zone instead of alert
      const sub = dropZone.querySelector(".drop-sub");
      if (sub) sub.textContent = "Error: " + err.message;
      console.error("XLSX parse error:", err);
    }
  };
  reader.onerror = function() {
    label.textContent = "Drop Excel file here";
    console.error("FileReader failed");
  };
  reader.readAsArrayBuffer(file);
}

// Load usage count + sheet choice + Cost assist defaults when popup opens
loadUsageCount();
loadOfferSheetSetting().catch(() => {});
loadSalarySettings().catch(() => {});

// ── Drag & drop ──
dropZone.addEventListener("dragover", e => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

// ── Clear file ──
fileClear.addEventListener("click", () => {
  parsedValues = {};
  loadedBuffer = null;
  sheetHint.classList.remove("visible");
  sheetHint.textContent = "";
  fileInput.value = "";
  dropZone.style.display = "";
  fileLoaded.classList.remove("visible");
  preview.classList.remove("visible");
  runBtn.classList.remove("visible");
  document.getElementById("currencyNote")?.classList.remove("visible");
  statusBox.classList.remove("visible");
  summaryEl.classList.remove("visible");
  logEl.innerHTML = "";
});

// ── Logging helpers ──
function log(icon, msg, active = false) {
  const line = document.createElement("div");
  line.className = "log-line";
  const cls = icon === "✓" ? "tick" : icon === "✗" ? "cross" : "wait";
  const iconSpan = document.createElement("span");
  iconSpan.className = cls;
  iconSpan.textContent = icon;
  const msgSpan = document.createElement("span");
  msgSpan.className = active ? "msg active" : "msg";
  msgSpan.textContent = msg;
  line.appendChild(iconSpan);
  line.appendChild(msgSpan);
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  return line;
}

function setStatus(state, label) {
  statusDot.className = "status-dot " + state;
  statusLabel.textContent = label;
}

// ── Run ──
runBtn.addEventListener("click", async () => {
  if (!Object.keys(parsedValues).length) return;

  runBtn.disabled = true;
  statusBox.classList.add("visible");
  summaryEl.classList.remove("visible");
  logEl.innerHTML = "";
  setStatus("running", "Running…");

  // Build the payload to send to content script
  const payload = activeBindings().map(b => ({
    label: b.label,
    value: parsedValues[b.label] || ""
  }));

  log("·", `Values from the "${offerSheet}" tab of the workbook`);

  // Get active tab and inject into ALL frames — form may be in an iframe
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    setStatus("error", "No active tab found");
    log("✗", "Open the SmartRecruiters offer form in the active tab, then click Fill Form Now.");
    runBtn.disabled = false;
    return;
  }

  log("·", `Scanning: ${(tab.url || "").slice(0, 80)}`);

  let results;
  const FILL_TIMEOUT_MS = 15000;
  try {
    results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: contentFill,
        args: [payload],
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(
          `Timed out after ${FILL_TIMEOUT_MS / 1000}s — page may still be loading, or the form has too many components`
        )), FILL_TIMEOUT_MS)
      ),
    ]);
  } catch (e) {
    setStatus("error", "Injection failed");
    log("✗", e.message);
    runBtn.disabled = false;
    return;
  }

  // Show logs + any per-frame errors from ALL frames
  for (const r of results || []) {
    if (r?.error) {
      log("✗", `Frame error: ${r.error.message || String(r.error)}`);
    }
    if (r?.result?.log?.length) {
      for (const e of r.result.log) log(e.ok ? "✓" : "✗", e.msg);
    }
  }

  const activeFrames = results?.filter(r => r?.result && !r.result.frameSkipped) || [];

  if (activeFrames.length === 0) {
    setStatus("error", "Form not found");
    log("✗", "No SmartRecruiters offer form fields found. Make sure the offer form is open and visible on screen, then try again.");
    runBtn.disabled = false;
    return;
  }

  let totalFilled = 0, totalCurrencies = 0;
  for (const r of activeFrames) {
    totalFilled     += r.result.filled     || 0;
    totalCurrencies += r.result.currencies || 0;
  }

  const data = { filled: totalFilled, currencies: totalCurrencies,
                 log: activeFrames.flatMap(r => r.result.log || []) };

  // Summary
  const errCount = data.log.filter(e => !e.ok).length;
  sumFilled.textContent   = data.filled;
  sumCurrency.textContent = data.currencies;
  sumCurrencyPill.classList.toggle("good", data.currencies > 0);
  sumErrors.textContent   = errCount;
  sumErrorPill.style.display = errCount > 0 ? "" : "none";
  summaryEl.classList.add("visible");

  setStatus(errCount === 0 ? "done" : "error",
            errCount === 0 ? `Done — ${data.filled} fields filled` : `Done with ${errCount} errors`);
  if (data.filled > 0) incrementUsageCount();
  runBtn.disabled = false;
});

// ── Cost assist: parallel 2×/3× queue from Applicants list ──
function setSalaryGoDisabled(val) {
  if (btnSalaryGo2x) btnSalaryGo2x.disabled = val;
  if (btnSalaryGo3x) btnSalaryGo3x.disabled = val;
}

async function handleSalaryGo(workers) {
  await saveSalarySettings().catch(() => {});
  try { await chrome.storage.local.remove("srAbortAll"); } catch (_) {}
  const cfg = readSalaryConfig();
  const maxParsed = parseCostAssistBudgetInput(cfg.maxSalary);
  if (!isFinite(maxParsed) || maxParsed <= 0) {
    salaryStatusBox.classList.add("visible");
    salaryLogEl.innerHTML = "";
    salaryLog("✗", "Enter a valid max budget (e.g. 3500000, 35,00,000, or 35L — same scale as screening answers).");
    setSalaryStatus("error", "Need max budget");
    return;
  }

  const tab = await getSmartRecruitersTab();
  if (!tab) {
    salaryStatusBox.classList.add("visible");
    salaryLogEl.innerHTML = "";
    salaryLog("✗", "Open SmartRecruiters (prospect list).");
    setSalaryStatus("error", "Wrong tab");
    return;
  }

  setSalaryGoDisabled(true);
  salaryStatusBox.classList.add("visible");
  salaryLogEl.innerHTML = "";
  setSalaryStatus("salary-running", "Starting…");

  try {
    // ensureKeywordCore injects the autoscroll + __srHarvestProfileUrls helpers (which
    // are list-generic, not keyword-specific) so we can collect profile URLs here.
    await ensureKeywordCore(tab.id);
    const [harvest] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: () => {
        if (typeof globalThis.__srAutoscrollApplicantListUntilLoaded === "function") {
          return globalThis.__srAutoscrollApplicantListUntilLoaded().then(() => {
            if (typeof globalThis.__srHarvestProfileUrls === "function") {
              return globalThis.__srHarvestProfileUrls();
            }
            return [];
          });
        }
        if (typeof globalThis.__srHarvestProfileUrls === "function") {
          return globalThis.__srHarvestProfileUrls();
        }
        return [];
      },
    });
    const urls = harvest?.result || [];
    if (!urls.length) {
      salaryLog("✗", "No profile URLs found — scroll to load applicants, then try again.");
      setSalaryStatus("error", "No profiles");
      setSalaryGoDisabled(false);
      return;
    }
    salaryLog("✓", "Found " + urls.length + " profiles. Starting " + workers + "× parallel workers…");
    // Worker tabs persist queue progress in chrome.storage.session — make sure it is
    // writable from content scripts before they launch.
    try { await chrome.runtime.sendMessage({ type: "srEnsureSessionAccess" }); } catch (_) {}
    const resp = await chrome.runtime.sendMessage({
      type: "srStartParallelSalaryQueue",
      urls,
      config: cfg,
      workers,
      returnUrl: tab.url,
    });
    if (resp?.ok) {
      salaryLog("✓", "Dispatched " + urls.length + " profiles across " + workers + " workers.");
      salaryLog("✓", cfg.dryRun ? "Dry run: reading screening answers only (never clicks Move)." : "Workers run in the background — results saved when finished.");
      setSalaryStatus("salary-done", "Cost assist running (" + workers + "× workers)");
    } else {
      salaryLog("✗", resp?.error || "Failed to start parallel queue.");
      setSalaryStatus("error", "Queue failed");
    }
  } catch (e) {
    salaryLog("✗", String(e?.message || e));
    setSalaryStatus("error", "Failed");
  }

  setSalaryGoDisabled(false);
}

btnSalaryGo2x.addEventListener("click", () => handleSalaryGo(2));
btnSalaryGo3x.addEventListener("click", () => handleSalaryGo(3));

// ── Global stop: kills whatever feature is running, regardless of active tab ──
// A keyword run launched from the Keyword tab can be stopped from the Cost assist
// Stop (the default tab when the popup opens) and vice versa.
async function stopEverything() {
  // Abort flag fires in all tab polling loops within ~200 ms — no tab lookup needed.
  try { await chrome.storage.local.set({ srAbortAll: true }); } catch (_) {}
  // Tell background to tear down any parallel queue (closes worker tabs if SW is alive).
  try { await chrome.runtime.sendMessage({ type: "srStopParallelKeywordQueue" }); } catch (_) {}
  // Clear both session queues (chrome.storage.session is extension-global — one remove
  // clears it for every tab at once).
  try { await chrome.storage.session.remove(["sr_ext_salary_triage_v1", "sr_ext_keyword_triage_v1"]); } catch (_) {}
  // Close worker tabs directly — handles the dead-service-worker case.
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.smartrecruiters.com/*" });
    const workerTabs = tabs.filter(t =>
      !t.active && /\/app\/people\/(applications|profile)\//i.test(t.url || "")
    );
    if (workerTabs.length) await chrome.tabs.remove(workerTabs.map(t => t.id)).catch(() => {});
  } catch (_) {}
}

btnSalaryStop.addEventListener("click", async () => {
  salaryStatusBox.classList.add("visible");
  salaryLogEl.innerHTML = "";
  await stopEverything();
  salaryLog("✓", "Stopped (all running tasks).");
  setSalaryStatus("salary-done", "Stopped");
});

// ── Keyword Search: DOM refs ──
const kwInput         = document.getElementById("kwInput");
const btnKwGo2x       = document.getElementById("btnKwGo2x");
const btnKwGo3x       = document.getElementById("btnKwGo3x");
const btnKwStop       = document.getElementById("btnKwStop");
const kwStatusBox     = document.getElementById("kwStatusBox");
const kwStatusDot     = document.getElementById("kwStatusDot");
const kwStatusLabel   = document.getElementById("kwStatusLabel");
const kwLogEl         = document.getElementById("kwLog");

const kwModeKeywordsBtn = document.getElementById("kwModeKeywords");
const kwModeBooleanBtn  = document.getElementById("kwModeBoolean");
const kwKeywordsSection = document.getElementById("kwKeywordsSection");
const kwBooleanSection  = document.getElementById("kwBooleanSection");
const kwBooleanInput    = document.getElementById("kwBooleanInput");

let kwCurrentMode = "keywords";

function setKwMode(mode) {
  kwCurrentMode = mode;
  const isKw = mode === "keywords";
  if (kwModeKeywordsBtn) kwModeKeywordsBtn.classList.toggle("active", isKw);
  if (kwModeBooleanBtn) kwModeBooleanBtn.classList.toggle("active", !isKw);
  if (kwKeywordsSection) kwKeywordsSection.style.display = isKw ? "" : "none";
  if (kwBooleanSection) kwBooleanSection.style.display = isKw ? "none" : "";
  saveKwSettings().catch(() => {});
}

if (kwModeKeywordsBtn) kwModeKeywordsBtn.addEventListener("click", () => setKwMode("keywords"));
if (kwModeBooleanBtn) kwModeBooleanBtn.addEventListener("click", () => setKwMode("boolean"));

const KW_STORAGE_KEYS = [
  "kwTriageKeywords",
  "kwTriageMode",
  "kwTriageBooleanQuery",
];

async function loadKwSettings() {
  const s = await chrome.storage.local.get(KW_STORAGE_KEYS);
  if (s.kwTriageKeywords != null) kwInput.value = String(s.kwTriageKeywords);
  if (s.kwTriageBooleanQuery != null && kwBooleanInput) {
    kwBooleanInput.value = String(s.kwTriageBooleanQuery);
  }
  if (s.kwTriageMode === "boolean") setKwMode("boolean");
  updateKwExpandedPreview();
}

async function saveKwSettings() {
  await chrome.storage.local.set({
    kwTriageKeywords: kwInput.value.trim(),
    kwTriageMode: kwCurrentMode,
    kwTriageBooleanQuery: kwBooleanInput ? kwBooleanInput.value : "",
  });
}

function readKwConfig(workers) {
  if (kwCurrentMode === "boolean") {
    return {
      mode: "boolean",
      booleanQuery: kwBooleanInput ? kwBooleanInput.value.trim() : "",
      keywords: "",
      postToNotes: true,
      workers: workers || 2,
    };
  }
  return {
    mode: "keywords",
    booleanQuery: "",
    keywords: kwInput.value.trim(),
    postToNotes: true,
    workers: workers || 2,
  };
}

function setKwGoDisabled(val) {
  if (btnKwGo2x) btnKwGo2x.disabled = val;
  if (btnKwGo3x) btnKwGo3x.disabled = val;
}

[kwInput, kwBooleanInput].forEach((el) => {
  if (!el) return;
  el.addEventListener("change", () => saveKwSettings().catch(() => {}));
});

// ── Keyword suggestions engine ──
/** Near-miss spellings → suggestion key (lowercase) for “Did you mean …” */
// Use the shared KEYWORD_TYPO_ALIASES table from keyword-expansions.js (loaded before popup.js)
const KW_TYPO_HINTS = (typeof KEYWORD_TYPO_ALIASES !== "undefined") ? KEYWORD_TYPO_ALIASES : {
  pytroch: "pytorch", pytoch: "pytorch",
  tensorlfow: "tensorflow", tensorfow: "tensorflow", tenserflow: "tensorflow",
  azuer: "azure",
};

const KW_RELATED = {
  // ── IAM / Identity & Access Management ──
  // These are the most likely keywords a TA recruiter in the identity space will type.
  // The suggestions help surface related tools/terms they might forget to add.
  "ping":            ["Ping Identity", "PingFederate", "Ping One", "Okta", "SailPoint", "ForgeRock", "CIAM", "SSO", "IAM"],
  "pingidentity":    ["PingFederate", "Ping One", "SAML", "OAuth", "OIDC", "SSO", "IAM", "Okta"],
  "ping identity":   ["PingFederate", "Ping One", "IAM", "SSO", "SAML", "Okta"],
  "sailpoint":       ["SailPoint IIQ", "IdentityNow", "IAM", "IGA", "identity governance", "Saviynt", "One Identity"],
  "sail point":      ["SailPoint", "IGA", "identity governance", "IAM"],
  "okta":            ["Okta Workforce", "Auth0", "Azure AD", "IAM", "SSO", "CIAM", "MFA"],
  "ciam":            ["Customer Identity", "Auth0", "Okta", "Ping Identity", "ForgeRock", "OAuth", "OIDC"],
  "iam":             ["Okta", "SailPoint", "CyberArk", "Ping Identity", "ForgeRock", "LDAP", "Active Directory", "IGA", "PAM"],
  "sso":             ["Single Sign-On", "SAML", "OAuth", "OIDC", "Okta", "Azure AD", "IAM", "Ping Identity"],
  "mfa":             ["Multi-Factor Authentication", "2FA", "Okta Verify", "Duo", "identity", "IAM"],
  "saml":            ["OIDC", "OAuth", "SSO", "federation", "identity provider", "IAM", "PingFederate"],
  "oauth":           ["OIDC", "SAML", "OAuth 2.0", "API security", "JWT", "SSO", "IAM"],
  "oidc":            ["OpenID Connect", "OAuth", "SAML", "SSO", "identity provider", "IAM"],
  "ldap":            ["Active Directory", "OpenLDAP", "IAM", "directory services", "ADFS"],
  "active directory": ["LDAP", "Azure AD", "ADFS", "Entra ID", "group policy", "SSO"],
  "azure ad":        ["Entra ID", "Active Directory", "ADFS", "SSO", "Okta", "IAM"],
  "entra":           ["Entra ID", "Azure AD", "Active Directory", "ADFS", "SSO", "Microsoft Identity"],
  "cyberark":        ["PAM", "privileged access", "Delinea", "BeyondTrust", "Thycotic", "vault"],
  "forgerock":       ["identity platform", "AM", "IDM", "Ping Identity", "IAM", "CIAM"],
  "pam":             ["Privileged Access Management", "CyberArk", "BeyondTrust", "Delinea", "Thycotic"],
  "iga":             ["identity governance", "SailPoint", "Saviynt", "One Identity", "IAM"],
  "saviynt":         ["IGA", "SailPoint", "identity governance", "IAM", "cloud security"],
  "beyondtrust":     ["PAM", "CyberArk", "privileged access", "Delinea", "IAM"],
  "delinea":         ["PAM", "CyberArk", "BeyondTrust", "Thycotic", "privileged access"],
  "auth0":           ["Okta", "CIAM", "IAM", "OAuth", "OIDC", "identity platform"],

  // ── Cloud / Kubernetes ──
  "gke":             ["Google Kubernetes Engine", "GCP", "Google Cloud", "EKS", "AKS", "Kubernetes", "K8s"],
  "eks":             ["Amazon Elastic Kubernetes Service", "AWS", "Kubernetes", "ECS", "GKE", "AKS", "K8s"],
  "aks":             ["Azure Kubernetes Service", "Azure", "Kubernetes", "EKS", "GKE", "K8s"],
  "ec2":             ["AWS", "virtual machine", "compute", "S3", "EKS", "cloud"],
  "s3":              ["AWS", "object storage", "cloud storage", "GCS", "Azure Blob"],
  "lambda":          ["serverless", "AWS", "FaaS", "cloud functions", "Azure Functions", "GCP"],

  // ── ML / AI ──
  "python":          ["pandas", "numpy", "scipy", "flask", "django", "fastapi", "jupyter"],
  "pytorch":         ["tensorflow", "keras", "deep learning", "neural networks", "cuda", "torchvision"],
  "tensorflow":      ["pytorch", "keras", "deep learning", "neural networks", "tflite"],
  "keras":           ["tensorflow", "pytorch", "deep learning", "neural networks"],
  "machine learning": ["deep learning", "scikit-learn", "xgboost", "random forest", "NLP", "computer vision"],
  "deep learning":   ["pytorch", "tensorflow", "keras", "CNN", "RNN", "transformer"],
  "nlp":             ["spacy", "BERT", "GPT", "huggingface", "transformers", "text mining", "sentiment analysis"],

  // ── Cloud platforms ──
  "aws":             ["EC2", "S3", "Lambda", "CloudFormation", "SageMaker", "EKS", "cloud"],
  "azure":           ["Azure DevOps", "AKS", "Azure Functions", "cloud", "Microsoft", "Entra"],
  "gcp":             ["BigQuery", "GKE", "Cloud Functions", "Vertex AI", "cloud"],
  "cloud":           ["AWS", "Azure", "GCP", "Kubernetes", "Docker", "Terraform"],
  "docker":          ["Kubernetes", "container", "Docker Compose", "Podman", "CI/CD"],
  "kubernetes":      ["Docker", "Helm", "EKS", "AKS", "GKE", "K8s"],

  // ── DevOps / CI-CD ──
  "jenkins":         ["GitHub Actions", "GitLab CI", "CI/CD", "CircleCI", "Terraform"],
  "github actions":  ["Jenkins", "GitLab CI", "CI/CD", "CircleCI"],
  "gitlab":          ["GitLab CI", "GitHub Actions", "Jenkins", "CI/CD", "Git"],
  "git":             ["GitHub", "GitLab", "Bitbucket", "version control"],
  "ci/cd":           ["Jenkins", "GitHub Actions", "GitLab CI", "ArgoCD", "Terraform"],
  "terraform":       ["Ansible", "CloudFormation", "Pulumi", "IaC", "infrastructure"],

  // ── Frontend ──
  "react":           ["Next.js", "Redux", "TypeScript", "JavaScript", "Vue", "Angular"],
  "angular":         ["TypeScript", "RxJS", "JavaScript", "React", "Vue"],
  "vue":             ["Nuxt.js", "Vuex", "JavaScript", "React", "Angular"],
  "javascript":      ["TypeScript", "Node.js", "React", "Vue", "Angular"],
  "typescript":      ["JavaScript", "Node.js", "React", "Angular"],
  "node.js":         ["Express", "NestJS", "JavaScript", "TypeScript", "npm"],

  // ── Backend / Data ──
  "java":            ["Spring Boot", "Maven", "Gradle", "Hibernate", "JUnit", "microservices"],
  "spring boot":     ["Java", "microservices", "REST API", "Hibernate", "Maven"],
  "sql":             ["PostgreSQL", "MySQL", "SQL Server", "database", "NoSQL"],
  "postgresql":      ["SQL", "database", "MySQL", "pgAdmin"],
  "mongodb":         ["NoSQL", "Mongoose", "database", "Redis"],
  "redis":           ["caching", "MongoDB", "Memcached", "database"],
  "elasticsearch":   ["Kibana", "Logstash", "ELK", "search", "Solr"],
  "kafka":           ["event streaming", "RabbitMQ", "Spark", "data pipeline"],
  "spark":           ["Hadoop", "data engineering", "PySpark", "Kafka", "Databricks"],
  "hadoop":          ["Spark", "HDFS", "MapReduce", "data engineering", "Hive"],

  // ── Domain / Standards ──
  "r&d":             ["research", "innovation", "patents", "product development"],
  "iso 45001":       ["ISO 9001", "ISO 14001", "OHSMS", "NEBOSH", "safety management"],
  "iso 9001":        ["ISO 45001", "ISO 14001", "quality management", "QMS"],
  "nebosh":          ["IOSH", "ISO 45001", "safety", "OSHA", "risk assessment"],
  "phd":             ["research", "thesis", "publications", "doctorate"],
  "agile":           ["Scrum", "Kanban", "JIRA", "sprint", "product owner"],
  "scrum":           ["Agile", "Kanban", "JIRA", "sprint planning"],
  "jira":            ["Agile", "Scrum", "Confluence", "Kanban", "project management"],
  "figma":           ["Sketch", "Adobe XD", "UI/UX", "design", "prototyping"],
  "data science":    ["machine learning", "statistics", "Python", "R", "pandas", "visualization"],
  "devops":          ["CI/CD", "Docker", "Kubernetes", "Terraform", "Jenkins", "monitoring"],
  "cybersecurity":   ["penetration testing", "SIEM", "SOC", "firewall", "encryption"],
  "golang":          ["Go", "microservices", "concurrency", "gRPC"],
  "rust":            ["systems programming", "WebAssembly", "memory safety"],
  "c++":             ["C", "systems programming", "embedded", "Qt", "game development"],
};

const kwSuggestionsBox = document.getElementById("kwSuggestionsBox");
let kwSuggestActiveIdx = -1;

function getLastToken(textarea) {
  const val = textarea.value || "";
  const cursor = textarea.selectionStart || val.length;
  const before = val.slice(0, cursor);
  const lastComma = before.lastIndexOf(",");
  return before.slice(lastComma + 1).trim().toLowerCase();
}

function getExistingKeywords(textarea) {
  return (textarea.value || "").split(/[,;\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

function showKwSuggestions() {
  const token = getLastToken(kwInput);
  kwSuggestionsBox.innerHTML = "";
  kwSuggestActiveIdx = -1;
  if (!token || token.length < 2) {
    kwSuggestionsBox.classList.remove("visible");
    return;
  }
  const existing = new Set(getExistingKeywords(kwInput));
  const suggestions = [];
  const seen = new Set();

  const typoTarget = KW_TYPO_HINTS[token];
  if (typoTarget && !existing.has(typoTarget)) {
    suggestions.push({ text: typoTarget, reason: "did you mean (typo)" });
    seen.add(typoTarget);
  }

  for (const [key, related] of Object.entries(KW_RELATED)) {
    if (key.startsWith(token) || key.includes(token)) {
      if (!existing.has(key) && !seen.has(key)) {
        suggestions.push({ text: key, reason: "match" });
        seen.add(key);
      }
      for (const r of related) {
        const rl = r.toLowerCase();
        if (!existing.has(rl) && !seen.has(rl)) {
          suggestions.push({ text: r, reason: "related to " + key });
          seen.add(rl);
        }
      }
    }
  }

  for (const [key, related] of Object.entries(KW_RELATED)) {
    for (const r of related) {
      if (r.toLowerCase().startsWith(token) || r.toLowerCase().includes(token)) {
        if (!existing.has(key) && !seen.has(key)) {
          suggestions.push({ text: key, reason: "has " + r });
          seen.add(key);
        }
      }
    }
  }

  if (!suggestions.length) {
    kwSuggestionsBox.classList.remove("visible");
    return;
  }

  const show = suggestions.slice(0, 12);
  for (let i = 0; i < show.length; i++) {
    const sg = show[i];
    const div = document.createElement("div");
    div.className = "kw-suggestion";
    div.dataset.idx = String(i);
    div.innerHTML = `<span class="sg-plus">+</span> <span>${sg.text}</span> <span class="sg-label">${sg.reason}</span>`;
    div.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (e.shiftKey) insertSuggestionBundle(sg.text);
      else insertSuggestion(sg.text);
    });
    kwSuggestionsBox.appendChild(div);
  }
  kwSuggestionsBox.classList.add("visible");
}

function insertSuggestion(text) {
  const val = kwInput.value || "";
  const cursor = kwInput.selectionStart || val.length;
  const before = val.slice(0, cursor);
  const after = val.slice(cursor);
  const lastComma = before.lastIndexOf(",");
  const prefix = lastComma >= 0 ? before.slice(0, lastComma + 1) + " " : "";
  kwInput.value = prefix + text + ", " + after.trimStart();
  kwInput.focus();
  const newPos = (prefix + text + ", ").length;
  kwInput.selectionStart = kwInput.selectionEnd = newPos;
  kwSuggestionsBox.classList.remove("visible");
  saveKwSettings().catch(() => {});
  setTimeout(showKwSuggestions, 50);
}

/** Insert primary keyword plus related terms (from KW_RELATED) not already listed */
function insertSuggestionBundle(primary) {
  const low = primary.toLowerCase();
  const related = KW_RELATED[low];
  const extra = related ? related.slice(0, 6) : [];
  const toAdd = [primary];
  const existing = new Set(getExistingKeywords(kwInput));
  for (const r of extra) {
    const rl = r.toLowerCase();
    if (!existing.has(rl) && !toAdd.some((t) => t.toLowerCase() === rl)) toAdd.push(r);
  }
  if (low === "pytorch" || low === "tensorflow" || low === "keras") {
    for (const x of ["machine learning", "deep learning"]) {
      if (!existing.has(x) && !toAdd.some((t) => t.toLowerCase() === x)) toAdd.push(x);
    }
  }
  const val = kwInput.value || "";
  const cursor = kwInput.selectionStart || val.length;
  const before = val.slice(0, cursor);
  const after = val.slice(cursor);
  const lastComma = before.lastIndexOf(",");
  const prefix = lastComma >= 0 ? before.slice(0, lastComma + 1) + " " : "";
  const block = toAdd.join(", ") + ", ";
  kwInput.value = prefix + block + after.trimStart();
  kwInput.focus();
  kwInput.selectionStart = kwInput.selectionEnd = (prefix + block).length;
  kwSuggestionsBox.classList.remove("visible");
  saveKwSettings().catch(() => {});
  setTimeout(showKwSuggestions, 50);
}

kwInput.addEventListener("input", showKwSuggestions);
kwInput.addEventListener("keydown", (e) => {
  if (!kwSuggestionsBox.classList.contains("visible")) return;
  const items = kwSuggestionsBox.querySelectorAll(".kw-suggestion");
  if (!items.length) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    kwSuggestActiveIdx = Math.min(kwSuggestActiveIdx + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle("active", i === kwSuggestActiveIdx));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    kwSuggestActiveIdx = Math.max(kwSuggestActiveIdx - 1, 0);
    items.forEach((el, i) => el.classList.toggle("active", i === kwSuggestActiveIdx));
  } else if ((e.key === "Enter" || e.key === "Tab") && kwSuggestActiveIdx >= 0) {
    e.preventDefault();
    const text = items[kwSuggestActiveIdx]?.querySelector("span:nth-child(2)")?.textContent;
    if (text) insertSuggestion(text);
  } else if (e.key === "Escape") {
    kwSuggestionsBox.classList.remove("visible");
  }
});

kwInput.addEventListener("blur", () => {
  setTimeout(() => kwSuggestionsBox.classList.remove("visible"), 150);
});

// ── Keyword expansion preview ──
const kwExpandedPreview = document.getElementById("kwExpandedPreview");
let kwPreviewTimer = null;

function updateKwExpandedPreview() {
  if (!kwExpandedPreview) return;
  const val = (kwInput.value || "").trim();
  if (!val) {
    kwExpandedPreview.innerHTML = "";
    kwExpandedPreview.classList.remove("visible");
    return;
  }
  try {
    const expTable = (typeof KEYWORD_EXPANSIONS !== "undefined") ? KEYWORD_EXPANSIONS : {};
    const typos    = (typeof KEYWORD_TYPO_ALIASES !== "undefined") ? KEYWORD_TYPO_ALIASES : {};
    const userKws  = val.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
    const userLow  = new Set(userKws.map(s => s.toLowerCase()));
    const globalSeen = new Set(userKws.map(s => s.toLowerCase()));

    // A compound keyword is one where the pattern engine inserts [\W_]* between chars
    // (any multi-word, hyphenated, or letter-digit boundary term).
    function isCompound(kw) {
      return /[\s\-_.]/.test(kw) || /[a-zA-Z]\d|\d[a-zA-Z]/.test(kw);
    }
    // Generate canonical separator examples for display only
    function sepExamples(kw) {
      const toks = kw.match(/[A-Za-z]+|\d+/g);
      if (!toks || toks.length < 2) return [];
      const joined = toks.join("");
      const title = toks.map(t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()).join("");
      const hyphen = toks.join("-");
      const under  = toks.join("_");
      const space  = toks.join(" ");
      const out = [];
      [joined, title, hyphen, under, space].forEach(f => {
        const fl = f.toLowerCase();
        if (fl !== kw.toLowerCase() && !out.some(x => x.toLowerCase() === fl)) out.push(f);
      });
      return out.slice(0, 3);
    }

    const rows = [];
    for (const kw of userKws) {
      const lower = kw.toLowerCase();
      const canonical = typos[lower] || lower;
      const synonyms = (expTable[canonical] || [])
        .filter(e => !globalSeen.has(e.toLowerCase()))
        .slice(0, 8);
      const hasSep = isCompound(kw) || synonyms.some(s => isCompound(s));
      const sepEx = hasSep ? sepExamples(canonical) : [];
      synonyms.forEach(s => globalSeen.add(s.toLowerCase()));

      if (synonyms.length || sepEx.length) {
        rows.push({ kw, synonyms, sepEx, typoFixed: canonical !== lower });
      }
    }

    if (!rows.length) {
      kwExpandedPreview.innerHTML = "";
      kwExpandedPreview.classList.remove("visible");
      return;
    }

    const headerHtml = `<div class="ep-header">Auto-captured variants (no need to add manually):</div>`;
    const rowsHtml = rows.map(r => {
      const corrected = r.typoFixed && typeof KEYWORD_TYPO_ALIASES !== "undefined"
        ? KEYWORD_TYPO_ALIASES[r.kw.toLowerCase()] : null;
      const kwHtml = corrected
        ? `<span class="ep-kw" title="typo corrected">${r.kw} → ${corrected}</span>`
        : `<span class="ep-kw">${r.kw}</span>`;
      const synTags = r.synonyms.map(s => `<span class="ep-tag">${s}</span>`).join("");
      const sepBadge = r.sepEx.length
        ? `<span class="ep-sep-badge">+ ${r.sepEx.join(" · ")} (spacing/case variants)</span>`
        : "";
      return `<div class="ep-row">${kwHtml}<span class="ep-arrow"> →</span> ${synTags}${sepBadge}</div>`;
    }).join("");

    kwExpandedPreview.innerHTML = headerHtml + rowsHtml;
    kwExpandedPreview.classList.add("visible");
  } catch (_) {
    kwExpandedPreview.classList.remove("visible");
  }
}

kwInput.addEventListener("input", () => {
  clearTimeout(kwPreviewTimer);
  kwPreviewTimer = setTimeout(updateKwExpandedPreview, 350);
});
kwInput.addEventListener("blur", () => {
  clearTimeout(kwPreviewTimer);
  updateKwExpandedPreview();
});

function kwLog(icon, msg) {
  const line = document.createElement("div");
  line.className = "log-line";
  const cls = icon === "✓" ? "tick" : icon === "✗" ? "cross" : "wait";
  const iconSpan = document.createElement("span");
  iconSpan.className = cls;
  iconSpan.textContent = icon;
  const msgSpan = document.createElement("span");
  msgSpan.className = "msg";
  msgSpan.textContent = msg;
  line.appendChild(iconSpan);
  line.appendChild(msgSpan);
  kwLogEl.appendChild(line);
  kwLogEl.scrollTop = kwLogEl.scrollHeight;
}

/** Indented diagnostic sub-line shown under a failed result entry. */
function kwLogSub(msg) {
  const line = document.createElement("div");
  line.className = "log-line sub";
  const iconSpan = document.createElement("span");
  iconSpan.className = "sub-icon";
  iconSpan.textContent = "↳";
  const msgSpan = document.createElement("span");
  msgSpan.className = "msg";
  msgSpan.textContent = msg;
  line.appendChild(iconSpan);
  line.appendChild(msgSpan);
  kwLogEl.appendChild(line);
  kwLogEl.scrollTop = kwLogEl.scrollHeight;
}

function setKwStatus(state, label) {
  kwStatusDot.className = "status-dot " + state;
  kwStatusLabel.textContent = label;
}

loadKwSettings().catch(() => {});

async function ensureKeywordCore(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    // storage-session-shim.js first — see ensureSalaryCore for why (predates-reload tabs).
    files: ["storage-session-shim.js", "keyword-expansions.js", "sr-list-autoscroll.js", "keyword-triage-core.js"],
  });
}

async function handleKwGo(workers) {
  await saveKwSettings().catch(() => {});
  try { await chrome.storage.local.remove("srAbortAll"); } catch (_) {}
  const cfg = readKwConfig(workers);
  if (cfg.mode === "boolean") {
    if (!cfg.booleanQuery) {
      kwStatusBox.classList.add("visible");
      kwLogEl.innerHTML = "";
      kwLog("✗", "Enter a boolean query (AND / OR / NOT).");
      setKwStatus("error", "Need boolean query");
      return;
    }
  } else if (!cfg.keywords) {
    kwStatusBox.classList.add("visible");
    kwLogEl.innerHTML = "";
    kwLog("✗", "Enter at least one keyword.");
    setKwStatus("error", "Need keywords");
    return;
  }

  const tab = await getSmartRecruitersTab();
  if (!tab) {
    kwStatusBox.classList.add("visible");
    kwLogEl.innerHTML = "";
    kwLog("✗", "Open SmartRecruiters (applicant list).");
    setKwStatus("error", "Wrong tab");
    return;
  }

  setKwGoDisabled(true);
  kwStatusBox.classList.add("visible");
  kwLogEl.innerHTML = "";
  setKwStatus("salary-running", "Starting…");

  try {
    await ensureKeywordCore(tab.id);
    const [harvest] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: () => {
        if (typeof globalThis.__srAutoscrollApplicantListUntilLoaded === "function") {
          return globalThis.__srAutoscrollApplicantListUntilLoaded().then(() => {
            if (typeof globalThis.__srHarvestProfileUrls === "function") {
              return globalThis.__srHarvestProfileUrls();
            }
            return [];
          });
        }
        if (typeof globalThis.__srHarvestProfileUrls === "function") {
          return globalThis.__srHarvestProfileUrls();
        }
        return [];
      },
    });
    const urls = harvest?.result || [];
    if (!urls.length) {
      kwLog("✗", "No profile URLs found — scroll to load applicants, then try again.");
      setKwStatus("error", "No profiles");
      setKwGoDisabled(false);
      return;
    }
    kwLog("✓", "Found " + urls.length + " profiles. Starting " + workers + "× parallel workers…");
    // Worker tabs persist queue progress in chrome.storage.session — make sure it is
    // writable from content scripts before they launch.
    try { await chrome.runtime.sendMessage({ type: "srEnsureSessionAccess" }); } catch (_) {}
    const resp = await chrome.runtime.sendMessage({
      type: "srStartParallelKeywordQueue",
      urls,
      config: cfg,
      workers,
      returnUrl: tab.url,
    });
    if (resp?.ok) {
      const modeLabel = cfg.mode === "boolean" ? "Boolean search" : "Keyword search";
      kwLog("✓", "Dispatched " + urls.length + " profiles across " + workers + " workers.");
      setKwStatus("salary-done", modeLabel + " running (" + workers + "× workers)");
    } else {
      kwLog("✗", resp?.error || "Failed to start parallel queue.");
      setKwStatus("error", "Queue failed");
    }
  } catch (e) {
    kwLog("✗", String(e?.message || e));
    setKwStatus("error", "Failed");
  }

  setKwGoDisabled(false);
}

btnKwGo2x.addEventListener("click", () => handleKwGo(2));
btnKwGo3x.addEventListener("click", () => handleKwGo(3));

btnKwStop.addEventListener("click", async () => {
  kwStatusBox.classList.add("visible");
  kwLogEl.innerHTML = "";
  // Global stop — kills any running feature (keyword OR cost assist), not just this tab's.
  await stopEverything();
  kwLog("✓", "Stopped (all running tasks).");
  setKwStatus("salary-done", "Stopped");
});

// ── View Last Run diagnostics ──
const btnKwLastRun = document.getElementById("btnKwLastRun");
if (btnKwLastRun) {
  btnKwLastRun.addEventListener("click", async () => {
    kwStatusBox.classList.add("visible");
    kwLogEl.innerHTML = "";
    try {
      const data = await chrome.storage.local.get("keywordTriageLastRun");
      const run = data.keywordTriageLastRun;
      // Storage limitation (Art. 5(1)(e)): ignore + purge snapshots older than 24h.
      const LASTRUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
      if (run && typeof run.finishedAt === "number" && run.finishedAt < Date.now() - LASTRUN_MAX_AGE_MS) {
        try { await chrome.storage.local.remove("keywordTriageLastRun"); } catch (_) {}
        kwLog("✗", "Previous run data expired (older than 24h) — run a keyword search first.");
        setKwStatus("error", "Expired");
        return;
      }
      if (!run) {
        kwLog("✗", "No previous run data found — run a keyword search first.");
        setKwStatus("error", "No data");
        return;
      }

      const results = run.results || [];
      const time = run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString() : "?";
      const withHits  = results.filter(r => r.hitCount > 0).length;
      const withNotes = results.filter(r => r.notesPosted).length;
      const withMove  = results.filter(r => r.moved).length;
      const skipped   = results.filter(r => r.skipped).length;

      const timings = results.map(r => r.totalMs).filter(Boolean);
      const avgTime = timings.length ? (timings.reduce((a, b) => a + b, 0) / timings.length / 1000).toFixed(1) : null;
      const totalTime = timings.length ? (timings.reduce((a, b) => a + b, 0) / 1000 / 60).toFixed(1) : null;
      const timeSummary = avgTime ? `  ·  ~${avgTime}s/profile` : "";
      kwLog("✓", `Last run: ${results.length} profiles @ ${time}${timeSummary}`);
      const notesFailed = results.filter(r => r.hitCount > 0 && !r.notesPosted).length;
      kwLog(withHits > 0 ? "✓" : "✗",
        `${withHits} matched  ·  ${withNotes} notes posted  ·  ${withMove} moved fwd  ·  ${skipped} skipped`);
      if (notesFailed > 0) {
        kwLog("✗", `${notesFailed} note${notesFailed > 1 ? "s" : ""} failed to post — see ↳ details below`);
      }

      for (const r of results.slice(0, 40)) {
        const seg = (r.url || "").split("/").slice(-2, -1)[0] || r.url.slice(-20);
        const kws = (r.matchedKeywords || []).slice(0, 3).join(", ") || "";
        const boolTag = (r.booleanPass != null) ? (r.booleanPass ? " PASS" : " FAIL") : "";
        // For 0-hit profiles, show text-source breakdown so extraction failures are obvious.
        // e.g. "0 hits [rsm:0 ttl:312]" means resume was empty but header/page text was found.
        const textHint = (r.hitCount === 0 && r.textStats)
          ? ` [rsm:${r.textStats.resumeLen} ttl:${r.textStats.totalLen}]` : "";
        const timeTag = r.totalMs ? `${(r.totalMs / 1000).toFixed(1)}s` : "";
        const tags = [
          r.skipped ? "skip" : "",
          r.hitCount > 0 ? r.hitCount + " hits" : "0 hits" + textHint,
          kws,
          boolTag,
          r.notesPosted ? "note✓" : (r.hitCount > 0 ? "note✗" + (r.notesFailReason ? " [" + r.notesFailReason.replace(/\s*—.*/, "").trim().slice(0, 30) + "]" : "") : ""),
          r.moved ? "fwd✓" : "",
          timeTag,
        ].filter(Boolean).join(" · ");
        kwLog(r.hitCount > 0 ? "✓" : "✗", `[${seg}] ${tags}`);
        // Show per-profile diagnostic log for note failures and 0-hit profiles.
        if (r.diagLog && r.diagLog.length) {
          for (const entry of r.diagLog) kwLogSub(entry);
        }
      }

      setKwStatus("salary-done", `Last run: ${results.length} profiles`);
    } catch (e) {
      kwLog("✗", String(e?.message || e));
      setKwStatus("error", "Failed to load");
    }
  });
}

// ── Inspect per-profile diagnostics (last 20 profile scans) ──
const btnKwDiagHistory = document.getElementById("btnKwDiagHistory");
const kwDiagPanel      = document.getElementById("kwDiagPanel");
if (btnKwDiagHistory && kwDiagPanel) {
  const DIAG_PREFIX = "lastRunDiag_";

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function shortUrl(u) {
    if (!u) return "(no url)";
    const seg = u.split("/").filter(Boolean).pop() || u;
    return seg.length > 28 ? seg.slice(0, 28) + "…" : seg;
  }

  async function loadDiagEntries() {
    const all = await chrome.storage.local.get(null);
    const entries = [];
    for (const k of Object.keys(all)) {
      if (k.indexOf(DIAG_PREFIX) === 0) entries.push(all[k]);
    }
    entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return entries;
  }

  function renderDetail(entry) {
    const t = new Date(entry.timestamp || 0).toLocaleString();
    const stats = entry.textStats || {};
    const src = entry.textSources || {};
    return `
      <div style="padding:6px 0;border-top:1px dashed var(--border);margin-top:4px">
        <div style="color:var(--muted);font-size:11px">${escapeHtml(t)}</div>
        <div style="word-break:break-all"><a href="${escapeHtml(entry.profileUrl||'')}" target="_blank" style="color:var(--accent)">${escapeHtml(entry.profileUrl||'(no url)')}</a></div>
        <div style="margin-top:4px">
          <span style="color:var(--accent)">matched:</span> ${escapeHtml((entry.matchedUserKeywords||[]).join(", ") || "—")}
        </div>
        <div>
          <span style="color:var(--warn)">missed:</span> ${escapeHtml((entry.missedUserKeywords||[]).join(", ") || "—")}
        </div>
        <div style="color:var(--muted);font-size:11px;margin-top:4px">
          lens: header ${stats.headerLen||0} · resume ${stats.resumeLen||0} · profile ${stats.profileLen||0} · screening ${stats.screeningLen||0} · fullPage ${stats.fullPageLen||0} · total ${stats.totalLen||0}
        </div>
        <div style="color:var(--muted);font-size:11px">
          input: ${escapeHtml(entry.userInput||"")} · type: ${escapeHtml(entry.type||"")} · ${entry.durationMs||0}ms
        </div>
        <details style="margin-top:6px">
          <summary style="cursor:pointer;color:var(--accent)">extractedText (${(entry.extractedText||"").length} chars)</summary>
          <textarea readonly style="width:100%;height:180px;background:var(--bg);color:var(--text);font-family:var(--mono);font-size:11px;border:1px solid var(--border);padding:4px;margin-top:4px">${escapeHtml(entry.extractedText||"")}</textarea>
        </details>
        <details style="margin-top:4px">
          <summary style="cursor:pointer;color:var(--accent)">per-source text</summary>
          <div style="font-size:11px">
            <div><b>header</b> (${(src.header||"").length})</div><textarea readonly style="width:100%;height:60px;background:var(--bg);color:var(--text);font-family:var(--mono);font-size:11px;border:1px solid var(--border);padding:4px">${escapeHtml(src.header||"")}</textarea>
            <div><b>resume</b> (${(src.resume||"").length})</div><textarea readonly style="width:100%;height:80px;background:var(--bg);color:var(--text);font-family:var(--mono);font-size:11px;border:1px solid var(--border);padding:4px">${escapeHtml(src.resume||"")}</textarea>
            <div><b>profile</b> (${(src.profile||"").length})</div><textarea readonly style="width:100%;height:60px;background:var(--bg);color:var(--text);font-family:var(--mono);font-size:11px;border:1px solid var(--border);padding:4px">${escapeHtml(src.profile||"")}</textarea>
            <div><b>screening</b> (${(src.screening||"").length})</div><textarea readonly style="width:100%;height:50px;background:var(--bg);color:var(--text);font-family:var(--mono);font-size:11px;border:1px solid var(--border);padding:4px">${escapeHtml(src.screening||"")}</textarea>
            <div><b>fullPage</b> (${(src.fullPage||"").length})</div><textarea readonly style="width:100%;height:80px;background:var(--bg);color:var(--text);font-family:var(--mono);font-size:11px;border:1px solid var(--border);padding:4px">${escapeHtml(src.fullPage||"")}</textarea>
          </div>
        </details>
      </div>
    `;
  }

  btnKwDiagHistory.addEventListener("click", async () => {
    kwStatusBox.classList.add("visible");
    if (kwDiagPanel.style.display === "block") {
      kwDiagPanel.style.display = "none";
      kwDiagPanel.innerHTML = "";
      return;
    }
    kwDiagPanel.style.display = "block";
    kwDiagPanel.innerHTML = '<div style="color:var(--muted)">loading…</div>';
    try {
      const entries = await loadDiagEntries();
      if (!entries.length) {
        kwDiagPanel.innerHTML = '<div style="color:var(--muted);padding:4px">No diagnostics yet — run a keyword search on at least one profile.</div>';
        return;
      }
      let html = `<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
        <span style="color:var(--muted)">${entries.length} entries</span>
        <button type="button" id="kwDiagCopyJson" class="btn-salary secondary" style="font-size:11px;padding:2px 8px">Copy all JSON</button>
        <button type="button" id="kwDiagClear" class="btn-salary danger" style="font-size:11px;padding:2px 8px" title="Erase all locally-stored candidate data: diagnostics + last-run results">Clear all candidate data</button>
      </div>`;
      entries.forEach((e, i) => {
        const matched = (e.matchedUserKeywords || []).length;
        const missed = (e.missedUserKeywords || []).length;
        const t = new Date(e.timestamp || 0).toLocaleTimeString();
        html += `<div data-diag-row="${i}" style="cursor:pointer;padding:4px 0;border-bottom:1px solid var(--border)">
          <span style="color:var(--muted)">${escapeHtml(t)}</span>
          · <span>${escapeHtml(shortUrl(e.profileUrl))}</span>
          · <span style="color:var(--accent)">${matched}✓</span>
          · <span style="color:var(--warn)">${missed}✗</span>
        </div>
        <div id="kwDiagDetail_${i}" style="display:none"></div>`;
      });
      kwDiagPanel.innerHTML = html;

      kwDiagPanel.querySelectorAll("[data-diag-row]").forEach((row) => {
        row.addEventListener("click", () => {
          const idx = row.getAttribute("data-diag-row");
          const detail = document.getElementById(`kwDiagDetail_${idx}`);
          if (!detail) return;
          if (detail.style.display === "block") {
            detail.style.display = "none";
            detail.innerHTML = "";
          } else {
            detail.style.display = "block";
            detail.innerHTML = renderDetail(entries[Number(idx)]);
          }
        });
      });

      document.getElementById("kwDiagCopyJson")?.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        try {
          await navigator.clipboard.writeText(JSON.stringify(entries, null, 2));
          ev.target.textContent = "Copied!";
          setTimeout(() => { ev.target.textContent = "Copy all JSON"; }, 1500);
        } catch (e) {
          ev.target.textContent = "Copy failed";
        }
      });

      document.getElementById("kwDiagClear")?.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        // Data-subject erasure (Art. 17): wipe ALL locally-stored candidate data —
        // diagnostics AND the last-run result snapshots (keyword + salary), not just diags.
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter(k => k.indexOf(DIAG_PREFIX) === 0);
        for (const k of ["keywordTriageLastRun", "salaryTriageLastRun"]) {
          if (k in all) keys.push(k);
        }
        if (!keys.length) {
          kwDiagPanel.innerHTML = '<div style="color:var(--muted);padding:4px">Nothing to clear.</div>';
          return;
        }
        await chrome.storage.local.remove(keys);
        kwDiagPanel.innerHTML = '<div style="color:var(--muted);padding:4px">Cleared all candidate data (diagnostics + last-run results).</div>';
      });
    } catch (e) {
      kwDiagPanel.innerHTML = `<div style="color:var(--warn)">Error: ${escapeHtml(String(e?.message || e))}</div>`;
    }
  });
}

function contentFill(payload) {
  const TARGET = "INR";
  const log = [];
  let filled = 0;
  let currencies = 0;

  const doc = document;
  const win = window;

  return (async () => {
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    const url = doc.location?.href || 'unknown';
    const bodyLen = (doc.body?.textContent || '').trim().length;

    // Skip empty frames
    if (bodyLen < 10) {
      return { filled: 0, currencies: 0, log: [], frameSkipped: true };
    }

    log.push({ ok: true, msg: `Frame: ${url.slice(0, 70)}` });

    // ── Helper: find all visible SmartRecruiters form blocks ────────────────
    // spl-form-element is an SR web component tag name; [id^="spl-form-element_"] is
    // a legacy ID-attribute fallback for older SR builds.
    function getBlocks() {
      let raw = Array.from(doc.querySelectorAll('spl-form-element'));
      if (!raw.length) {
        raw = Array.from(doc.querySelectorAll('[id^="spl-form-element_"]'));
      }
      return raw.filter(el => {
        const style = win.getComputedStyle(el);
        return style && style.display !== "none" && style.visibility !== "hidden";
      });
    }

    // ── Collect deep text for an element, including nested shadow roots ─────
    function getDeepText(root) {
      let out = "";
      const visited = new Set();

      function walk(node) {
        if (!node || visited.has(node)) return;
        visited.add(node);

        if (node.nodeType === Node.TEXT_NODE) {
          out += node.textContent || "";
          return;
        }

        // Walk light DOM children
        if (node.childNodes && node.childNodes.length) {
          for (const ch of node.childNodes) walk(ch);
        }

        // Walk any shadow root attached to this element
        const sr = node.shadowRoot;
        if (sr && sr.childNodes && sr.childNodes.length) {
          for (const ch of sr.childNodes) walk(ch);
        }
      }

      walk(root);
      return out;
    }

    // ── Collect all INPUTs inside an element, including nested shadow roots ─
    function getDeepInputs(root) {
      const inputs = [];
      const visited = new Set();

      function walk(node) {
        if (!node || visited.has(node)) return;
        visited.add(node);

        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "INPUT") {
          const el = node;
          if (!el.disabled && el.type !== "hidden") inputs.push(el);
        }

        if (node.childNodes && node.childNodes.length) {
          for (const ch of node.childNodes) walk(ch);
        }

        const sr = node.shadowRoot;
        if (sr && sr.childNodes && sr.childNodes.length) {
          for (const ch of sr.childNodes) walk(ch);
        }
      }

      walk(root);
      return inputs;
    }

    // ── Collect elements whose deep text contains a token (e.g. USD / INR) ──
    function getDeepTokenElements(root, token) {
      const els = [];
      const visited = new Set();
      const upToken = String(token || "").toUpperCase();

      function walk(node) {
        if (!node || visited.has(node)) return;
        visited.add(node);

        if (node.nodeType === Node.ELEMENT_NODE) {
          const txt = (node.textContent || "").toUpperCase();
          if (txt.includes(upToken)) els.push(node);
        }

        if (node.childNodes && node.childNodes.length) {
          for (const ch of node.childNodes) walk(ch);
        }

        const sr = node.shadowRoot;
        if (sr && sr.childNodes && sr.childNodes.length) {
          for (const ch of sr.childNodes) walk(ch);
        }
      }

      walk(root);
      return els;
    }

    // Global scan for a token anywhere in the document (across all shadows)
    function getAllTokenElements(token) {
      return getDeepTokenElements(doc.documentElement || doc.body || doc, token);
    }

    const blockElements = getBlocks();
    if (!blockElements.length) {
      const bodySnip = (doc.body?.innerText || "").replace(/\s+/g, " ").slice(0, 100);
      log.push({ ok: false, msg: `No spl-form-element blocks found on this frame.` });
      log.push({ ok: true,  msg: `Page text: "${bodySnip}"` });
      return { filled: 0, currencies: 0, log, frameSkipped: true };
    }

    // Precompute deep text + deep inputs for each block
    const blocks = blockElements.map(el => {
      const rawText = getDeepText(el);
      const inputs = getDeepInputs(el);
      return {
        el,
        text: rawText,
        normText: normText(rawText),
        inputs
      };
    });

    log.push({ ok: true, msg: `Found ${blocks.length} SmartRecruiters form blocks` });

    // ── Helper: dedupe blocks based on approximate position ─────────────────
    function dedupeByPosition(elements) {
      const uniq = [];
      for (const el of elements) {
        const bb = el.getBoundingClientRect();
        if (!bb || !bb.width || !bb.height) continue;
        let dupe = false;
        for (const ex of uniq) {
          const b2 = ex.getBoundingClientRect();
          if (!b2) continue;
          if (Math.abs(bb.x - b2.x) < 10 && Math.abs(bb.y - b2.y) < 10) {
            dupe = true;
            break;
          }
        }
        if (!dupe) uniq.push(el);
      }
      return uniq;
    }

    function isVisible(el) {
      if (!el) return false;
      const style = win.getComputedStyle(el);
      if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      const r = el.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    }

    // ── Small helpers for fuzzy text matching ───────────────────────────────
    function normText(s) {
      return (s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function overlapScore(a, b) {
      const wa = new Set(a.split(" ").filter(Boolean));
      const wb = new Set(b.split(" ").filter(Boolean));
      if (!wa.size || !wb.size) return 0;
      let overlap = 0;
      for (const w of wa) if (wb.has(w)) overlap++;
      return overlap / Math.min(wa.size, wb.size);
    }

    // ── Currency dropdown automation ────────────────────────────────────────
    // Walks shadow DOM with a predicate; used below for finding dropdowns and options.
    function collectDeep(root, test) {
      const out = [];
      const visited = new Set();
      function walk(node) {
        if (!node || visited.has(node)) return;
        visited.add(node);
        if (node.nodeType === Node.ELEMENT_NODE && test(node)) out.push(node);
        for (let i = 0; i < (node.childNodes?.length || 0); i++) walk(node.childNodes[i]);
        if (node.shadowRoot) walk(node.shadowRoot);
      }
      walk(root);
      return out;
    }

    async function changeAllCurrenciesLikePython(allBlocks) {
      const CURRENCY_RE = /^[A-Z]{3}$/;
      let changed = 0;
      let attempted = 0;

      // ── Pass 1: standard <select> with a TARGET option anywhere in shadow DOM ──
      const selects = collectDeep(doc.documentElement, n =>
        n.tagName === 'SELECT' &&
        Array.from(n.options || []).some(o =>
          o.value.trim() === TARGET || o.text.trim() === TARGET
        )
      );
      for (const sel of selects) {
        const curText = (sel.options[sel.selectedIndex]?.text || sel.value || '').trim();
        if (curText === TARGET) continue;
        attempted++;
        const nativeSetter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(sel, TARGET);
        else sel.value = TARGET;
        sel.dispatchEvent(new win.Event('change', { bubbles: true }));
        log.push({ ok: true, msg: `Currency <select>: ${curText} → ${TARGET}` });
        changed++;
        currencies++;
      }

      // ── Pass 2: SR web-component currency pickers ──
      // Search within each form block rather than the whole document.
      // Whole-document search finds the same dropdown 2-3× through nested shadow levels
      // (spl-form-element → spl-dropdown → spl-select all carry value="USD"), multiplying
      // the 700ms/candidate cost by 2-3× and causing 30+ second hangs on 17-field forms.
      // Per-block search picks only the deepest (actual control) candidate per field.
      const seen = new Set();
      const componentCandidates = [];
      for (const block of (allBlocks || [])) {
        const inBlock = collectDeep(block.el, n => {
          if (n.nodeType !== Node.ELEMENT_NODE) return false;
          const tag = n.tagName.toLowerCase();
          const role = (n.getAttribute?.('role') || '').toLowerCase();
          if (!tag.startsWith('spl-') && !tag.startsWith('sr-') && role !== 'combobox') return false;
          const val = (n.getAttribute?.('value') || '').trim();
          return CURRENCY_RE.test(val) && val !== TARGET;
        });
        // Take the deepest match (the actual dropdown control, not the outer wrapper)
        if (inBlock.length) {
          const pick = inBlock[inBlock.length - 1];
          if (!seen.has(pick)) {
            seen.add(pick);
            componentCandidates.push(pick);
          }
        }
      }
      log.push({ ok: true, msg: `Currency candidates: ${componentCandidates.length} (1 per block)` });

      for (const comp of componentCandidates) {
        const prevVal = comp.getAttribute('value') || '';
        attempted++;

        // Attempt A only: programmatic prototype setter (synchronous, no sleeps).
        // Click-based fallback (Attempt B) was removed — it required 400–700 ms per candidate
        // and caused 30+ second hangs on forms with many currency fields. If the setter
        // isn't exposed by this SR build, the user changes remaining fields manually
        // (the "Currency change must be done manually" note already tells them this).
        try {
          const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(comp), 'value');
          if (desc?.set) {
            desc.set.call(comp, TARGET);
            comp.dispatchEvent(new win.Event('change', { bubbles: true }));
            comp.dispatchEvent(new win.CustomEvent('spl-change', { bubbles: true, detail: { value: TARGET } }));
            log.push({ ok: true, msg: `Currency: ${prevVal} → ${TARGET}` });
            changed++;
            currencies++;
          } else {
            log.push({ ok: false, msg: `Currency ${prevVal}: no setter — change manually` });
          }
        } catch (_) {
          log.push({ ok: false, msg: `Currency ${prevVal}: setter threw — change manually` });
        }
      }

      if (attempted === 0) {
        log.push({ ok: true, msg: 'No currency dropdowns need changing' });
      } else if (changed < attempted) {
        log.push({ ok: false, msg: `Auto-changed ${changed}/${attempted} currency fields — set remaining to ${TARGET} manually` });
      }
    }

    // ── Angular-friendly value setter on a real INPUT element ───────────────
    function setValOnInput(input, value) {
      try { input.focus(); } catch (_) {}

      const proto = input.constructor && input.constructor.prototype
        ? input.constructor.prototype
        : win.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (nativeSetter) nativeSetter.call(input, value);
      else input.value = value;

      input.dispatchEvent(new win.Event("input",  { bubbles: true }));
      input.dispatchEvent(new win.Event("change", { bubbles: true }));
      input.dispatchEvent(new win.Event("blur",   { bubbles: true }));
    }

    // ── Data entry: target the deepest INPUT in each matched block ──────────
    async function fillFieldsLikePython(allBlocks) {
      for (let i = 0; i < payload.length; i++) {
        const { label, value } = payload[i];
        const idx = String(i + 1).padStart(2, "0");

        if (!value) {
          log.push({ ok: true, msg: `[${idx}] ${label}: (empty, skipped)` });
          continue;
        }

        const labelNorm = normText(label);

        // Pass 1 — block text begins with the field label (the label renders
        // first inside each spl-form-element). Word-overlap alone can't tell
        // apart same-word-set pairs like "Annual Salary" vs
        // "Total Base Salary (Annual)", which both score 1.0.
        const prefixMatches = allBlocks.filter(info =>
          info.normText === labelNorm || info.normText.startsWith(labelNorm + " ")
        );
        let matchInfo = null;
        if (prefixMatches.length === 1) {
          matchInfo = prefixMatches[0];
        } else if (prefixMatches.length > 1) {
          // e.g. "Annual Bonus" prefixes both "Annual Bonus" and
          // "Annual Bonus (% based)". Prefer the block whose text continues
          // with a currency code or a number (an amount field), else DOM order.
          matchInfo = prefixMatches.find(info => {
            const rest = info.normText.slice(labelNorm.length).trim();
            return /^([a-z]{3}( |$)|\d)/.test(rest);
          }) || prefixMatches[0];
        }

        // Pass 2 — fuzzy word-overlap fallback on deep text (incl. shadow DOM)
        if (!matchInfo) {
          let bestInfo = null;
          let bestScore = 0;
          for (const info of allBlocks) {
            const score = overlapScore(labelNorm, info.normText);
            if (score > bestScore) {
              bestScore = score;
              bestInfo = info;
            }
          }
          matchInfo = bestScore >= 0.5 ? bestInfo : null;
          if (!matchInfo) {
            log.push({ ok: false, msg: `[${idx}] ${label}: block not found (best score=${bestScore.toFixed(2)})` });
            continue;
          }
        }

        // Prefer a concrete INPUT inside this block rather than generic container
        let inputTarget = null;
        const inputs = matchInfo.inputs || [];
        if (inputs.length === 1) {
          inputTarget = inputs[0];
        } else if (inputs.length > 1) {
          // Choose the widest visible INPUT (tends to be the amount box)
          let best = null;
          let bestW = 0;
          for (const inp of inputs) {
            const r = inp.getBoundingClientRect();
            if (!r || !r.width || !r.height) continue;
            const style = win.getComputedStyle(inp);
            if (style.display === "none" || style.visibility === "hidden") continue;
            if (r.width > bestW) {
              bestW = r.width;
              best = inp;
            }
          }
          inputTarget = best || inputs[inputs.length - 1];
        }

        const blockEl = matchInfo.el;
        const bb = blockEl.getBoundingClientRect();
        if (!bb || !bb.width || !bb.height) {
          log.push({ ok: false, msg: `[${idx}] ${label}: no bounding box` });
          continue;
        }

        const clickX = bb.left + bb.width * 0.7;
        const clickY = bb.top + bb.height / 2;

        // Convert viewport coords to client coords for mouse events
        const target = doc.elementFromPoint(clickX, clickY) || blockEl;

        try {
          target.scrollIntoView({ block: "center", behavior: "instant" });
        } catch (_) {}
        await sleep(20);

        const evtOpts = {
          bubbles: true,
          cancelable: true,
          clientX: clickX,
          clientY: clickY
        };
        target.dispatchEvent(new win.MouseEvent("mousedown", evtOpts));
        target.dispatchEvent(new win.MouseEvent("mouseup", evtOpts));
        target.dispatchEvent(new win.MouseEvent("click", evtOpts));

        await sleep(20);

        const active = doc.activeElement;
        const finalInput = inputTarget || (active && active.tagName === "INPUT" ? active : null);
        if (finalInput) {
          setValOnInput(finalInput, value);
        }

        filled++;
        log.push({ ok: true, msg: `[${idx}] ${label}: ${value} ✓` });
        await sleep(15);
      }
    }

    await changeAllCurrenciesLikePython(blocks);
    await sleep(100);
    await fillFieldsLikePython(blocks);

    return { filled, currencies, log };
  })();
}
