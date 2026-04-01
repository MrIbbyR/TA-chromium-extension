// popup.js — SR Tools: Mr Offer + Cost assist
// Uses xlsx-mini.js (local, self-contained — no CDN required).

const BINDINGS = [
  { label: "Annual Salary",                       cell: "E16" },  // Same as Total Base Salary (Annual)
  { label: "Pay Based on Frequency",              cell: "D6"  },
  { label: "Basic Pay (Annual)",                  cell: "E6"  },
  { label: "House Rent Allowance (Monthly)",      cell: "D7"  },
  { label: "House Rent Allowance (annual)",       cell: "E7"  },
  { label: "General Allowance (Monthly)",         cell: "D8"  },
  { label: "General Allowance (annual)",          cell: "E8"  },
  { label: "Cash Salary (Monthly) Section",       cell: "D10" },
  { label: "Cash Salary (Annual) Section",        cell: "E10" },
  { label: "Employer PF Contribution (Monthly)",  cell: "D13" },
  { label: "Employer PF Contribution (annual)",   cell: "E13" },
  { label: "Total Base Salary (Monthly)",         cell: "D16" },
  { label: "Total Base Salary (Annual)",          cell: "E16" },
  { label: "Monthly Bonus",                       cell: "D19" },
  { label: "Annual Bonus",                        cell: "E19" },
  { label: "Total Cash Compensation (Monthly)",   cell: "D21" },
  { label: "Total Cash Compensation (Annual)",    cell: "E21" },
];

// ── State ──
let parsedValues = {};  // { cell: formattedString }

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

const tabOffer  = document.getElementById("tabOffer");
const tabSalary = document.getElementById("tabSalary");
const panelOffer  = document.getElementById("panel-offer");
const panelSalary = document.getElementById("panel-salary");

const salaryMax       = document.getElementById("salaryMax");
const salaryMin       = document.getElementById("salaryMin");
const salaryWait      = document.getElementById("salaryWait");
const salaryDryRun    = document.getElementById("salaryDryRun");
const btnSalaryQueue    = document.getElementById("btnSalaryQueue");
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
  const offer = which === "offer";
  tabOffer.classList.toggle("active", offer);
  tabSalary.classList.toggle("active", !offer);
  panelOffer.classList.toggle("visible", offer);
  panelSalary.classList.toggle("visible", !offer);
}

tabOffer.addEventListener("click", () => showPanel("offer"));
tabSalary.addEventListener("click", () => showPanel("salary"));

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
    screeningWaitMs: salaryWait.value.trim() === "" ? 1200 : parseInt(salaryWait.value, 10),
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
  line.innerHTML = `<span class="${cls}">${icon}</span><span class="msg">${msg}</span>`;
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
    files: ["salary-triage-core.js"],
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
async function parseExcel(arrayBuffer) {
  const cells = await window.XLSXMini.parseXLSX(arrayBuffer);
  const values = {};
  const needed = [...new Set(BINDINGS.map(b => b.cell))];
  for (const addr of needed) {
    values[addr] = cells[addr] ? fmtNum(cells[addr]) : "";
  }
  return values;
}

// ── Build preview table ──
function buildPreview(values) {
  previewTable.innerHTML = "";
  let filled = 0;
  for (const b of BINDINGS) {
    const v = values[b.cell] || "";
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

// ── Handle file ──
function handleFile(file) {
  if (!file) return;

  const label = dropZone.querySelector(".drop-label");
  label.textContent = "Reading…";

  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const values = await parseExcel(e.target.result);

      // Derive missing monthly values from annual ones if the Excel file
      // does not contain them explicitly.
      const derivePairs = [
        // Cash Salary (Monthly) Section  ←  Cash Salary (Annual) Section
        { monthly: "D10", annual: "E10" },
        // Total Base Salary (Monthly)    ←  Total Base Salary (Annual)
        { monthly: "D16", annual: "E16" },
        // Total Cash Compensation (Monthly) ← Total Cash Compensation (Annual)
        { monthly: "D21", annual: "E21" },
      ];
      for (const { monthly, annual } of derivePairs) {
        if (!values[monthly] && values[annual]) {
          const n = parseFloat(String(values[annual]).replace(/,/g, ""));
          if (!isNaN(n) && isFinite(n)) {
            values[monthly] = String(Math.round(n / 12));
          }
        }
      }
      parsedValues = values;
      buildPreview(values);
      const nonEmpty = Object.values(values).filter(Boolean).length;

      dropZone.style.display = "none";
      fileLoaded.classList.add("visible");
      fileName.textContent = file.name;
      fieldCount.textContent = `${nonEmpty} of ${BINDINGS.length} fields have values`;
      preview.classList.add("visible");
      runBtn.classList.add("visible");
      document.getElementById("currencyNote")?.classList.add("visible");
      statusBox.classList.remove("visible");
      summaryEl.classList.remove("visible");
      logEl.innerHTML = "";
    } catch(err) {
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

// Load usage count + Cost assist defaults when popup opens
loadUsageCount();
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
  line.innerHTML = `<span class="${cls}">${icon}</span><span class="msg ${active ? "active" : ""}">${msg}</span>`;
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
  const payload = BINDINGS.map(b => ({
    label: b.label,
    value: parsedValues[b.cell] || ""
  }));

  // Get active tab and inject into ALL frames — form may be in an iframe
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: contentFill,
      args: [payload],
    });
  } catch (e) {
    setStatus("error", "Injection failed");
    log("✗", "Could not inject: " + e.message);
    runBtn.disabled = false;
    return;
  }

  // Always show logs from ALL frames (including diagnostic-only frames)
  for (const r of results || []) {
    if (r?.result?.log?.length) {
      for (const e of r.result.log) log(e.ok ? "✓" : "✗", e.msg);
    }
  }

  const activeFrames = results?.filter(r => r?.result && !r.result.frameSkipped) || [];

  if (activeFrames.length === 0) {
    setStatus("error", "Form not found — see logs above");
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

// ── Cost assist: queue from Applicants list ──
btnSalaryQueue.addEventListener("click", async () => {
  await saveSalarySettings().catch(() => {});
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

  btnSalaryQueue.disabled = true;
  salaryStatusBox.classList.add("visible");
  salaryLogEl.innerHTML = "";
  setSalaryStatus("salary-running", "Starting…");

  try {
    await ensureSalaryCore(tab.id);
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: (c) => globalThis.__srSalaryTriageStartQueue(c),
      args: [cfg],
    });
    const out = inj?.result;
    const lines = out?.log || [];
    for (const e of lines) salaryLog(e.ok ? "✓" : "✗", e.msg);
    if (out?.ok && out?.queued) {
      const modeHint =
        out.mode === "click"
          ? "Click-through queue: opening each name in the same tab."
          : "URL queue: jumping to each profile URL.";
      salaryLog("✓", modeHint);
      salaryLog("✓", "Keep this browser tab focused; results also saved when finished.");
      setSalaryStatus("salary-done", "Cost assist running — keep tab focused");
    } else {
      setSalaryStatus("error", "Queue failed");
    }
  } catch (e) {
    salaryLog("✗", String(e?.message || e));
    setSalaryStatus("error", "Failed");
  }

  btnSalaryQueue.disabled = false;
});

// ── Stop queue ──
btnSalaryStop.addEventListener("click", async () => {
  const tab = await getSmartRecruitersTab();
  salaryStatusBox.classList.add("visible");
  salaryLogEl.innerHTML = "";
  if (!tab) {
    salaryLog("✗", "Open a SmartRecruiters tab to clear queue.");
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: () => {
        try {
          sessionStorage.removeItem("sr_ext_salary_triage_v1");
          sessionStorage.removeItem("sr_ext_salary_triage_busy");
        } catch (_) {}
      },
    });
    salaryLog("✓", "Cost assist queue cleared.");
    setSalaryStatus("salary-done", "Stopped");
  } catch (e) {
    salaryLog("✗", String(e?.message || e));
  }
});

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
    function getBlocks() {
      const raw = Array.from(
        doc.querySelectorAll('[id^="spl-form-element_"]')
      );
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
      log.push({ ok: false, msg: `No SmartRecruiters blocks found (id^="spl-form-element_").` });
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

    // ── Currencies: disabled for stability; do numeric only ────────────────
    async function changeAllCurrenciesLikePython() {
      log.push({
        ok: false,
        msg: "Currency auto-change skipped (please change USD → INR manually)"
      });
      return;
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

        // Fuzzy label → block matching on deep text (including shadow DOM)
        const labelNorm = normText(label);
        let bestInfo = null;
        let bestScore = 0;

        for (const info of allBlocks) {
          const score = overlapScore(labelNorm, info.normText);
          if (score > bestScore) {
            bestScore = score;
            bestInfo = info;
          }
        }

        const matchInfo = bestScore >= 0.5 ? bestInfo : null;

        if (!matchInfo) {
          log.push({ ok: false, msg: `[${idx}] ${label}: block not found (best score=${bestScore.toFixed(2)})` });
          continue;
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
          target.scrollIntoView({ block: "center", behavior: "smooth" });
        } catch (_) {}
        await sleep(80);

        const evtOpts = {
          bubbles: true,
          cancelable: true,
          clientX: clickX,
          clientY: clickY
        };
        target.dispatchEvent(new win.MouseEvent("mousedown", evtOpts));
        target.dispatchEvent(new win.MouseEvent("mouseup", evtOpts));
        target.dispatchEvent(new win.MouseEvent("click", evtOpts));

        await sleep(80);

        const active = doc.activeElement;
        const finalInput = inputTarget || (active && active.tagName === "INPUT" ? active : null);
        if (finalInput) {
          setValOnInput(finalInput, value);
        }

        filled++;
        log.push({ ok: true, msg: `[${idx}] ${label}: ${value} ✓` });
        await sleep(40);
      }
    }

    await changeAllCurrenciesLikePython(blocks);
    await sleep(300);
    await fillFieldsLikePython(blocks);

    return { filled, currencies, log };
  })();
}
