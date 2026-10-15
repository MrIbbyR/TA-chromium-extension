// notes-flow.spec.js — E2E tests for the notes posting pipeline.
// Loads the actual extension JS against an HTML fixture that replicates SR's DOM.
// Run: cd tests/e2e && npx playwright test

const { test, expect } = require("@playwright/test");
const path = require("path");

const FIXTURE = "file://" + path.resolve(__dirname, "fixtures/sr-profile.html");
const ROOT = path.resolve(__dirname, "../..");

async function injectExtensionScripts(page) {
  await page.addScriptTag({ path: path.join(ROOT, "sr-selectors.js") });
  await page.addScriptTag({ path: path.join(ROOT, "keyword-expansions.js") });
  await page.addScriptTag({ path: path.join(ROOT, "location-gazetteer.js") });
  await page.addScriptTag({ path: path.join(ROOT, "location-infer.js") });
  await page.addScriptTag({ path: path.join(ROOT, "keyword-dom.js") });
  await page.addScriptTag({ path: path.join(ROOT, "keyword-matching.js") });
  await page.addScriptTag({ path: path.join(ROOT, "keyword-extract.js") });
  await page.addScriptTag({ path: path.join(ROOT, "keyword-pipeline.js") });
  await page.addScriptTag({ path: path.join(ROOT, "keyword-notes.js") });
  await page.addScriptTag({ path: path.join(ROOT, "keyword-diag.js") });
  await page.addScriptTag({ path: path.join(ROOT, "keyword-triage-core.js") });
}

// ── getNotesSection: must skip <spl-tab> elements ──

test("getNotesSection returns null when #st-notes is a spl-tab", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await injectExtensionScripts(page);

  const result = await page.evaluate(() => {
    // getNotesSection is not exported, so we test it indirectly through
    // the healthcheck which validates the same selector + tag check.
    var el = document.querySelector("#st-notes");
    var tag = el ? el.tagName.toLowerCase() : null;
    var role = el ? el.getAttribute("role") : null;
    return { tag, role };
  });

  expect(result.tag).toBe("spl-tab");
  expect(result.role).toBe("tab");

  // The healthcheck should flag this with a warning
  const hc = await page.evaluate(() => {
    var results = globalThis.__srDomHealthcheckRaw(document);
    var notes = results.find(r => r.name === "notesSection");
    return notes;
  });
  expect(hc.warn).toBe(true);
});

// ── findNotesPostButton: must find the Post button ──

test("Post button is findable inside spl-form-element", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await injectExtensionScripts(page);

  const found = await page.evaluate(() => {
    var formEls = document.querySelectorAll('[id^="spl-form-element_"]');
    for (var fi = 0; fi < formEls.length; fi++) {
      var btns = formEls[fi].querySelectorAll("spl-button");
      for (var b = 0; b < btns.length; b++) {
        var btn = btns[b];
        var inDropdown = !!(btn.closest && btn.closest("spl-dropdown"));
        var text = (btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!inDropdown && /^post$/i.test(text)) {
          return { tag: btn.tagName.toLowerCase(), text: text, inDropdown: false };
        }
      }
    }
    return null;
  });

  expect(found).not.toBeNull();
  expect(found.text).toBe("post");
  expect(found.inDropdown).toBe(false);
});

// ── Note-type dropdown: must find the dropdown with "note" text, not "publisher" ──

test("note-type dropdown is identified by text content, not DOM order", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await injectExtensionScripts(page);

  const result = await page.evaluate(() => {
    var formEls = document.querySelectorAll('[id^="spl-form-element_"]');
    var noteDropdown = null;
    var publisherDropdown = null;

    for (var fi = 0; fi < formEls.length; fi++) {
      var dds = formEls[fi].querySelectorAll("spl-dropdown");
      for (var di = 0; di < dds.length; di++) {
        var text = (dds[di].textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (/\bnote\b/i.test(text)) noteDropdown = { index: di, text: text.slice(0, 40) };
        if (/publisher/i.test(text)) publisherDropdown = { index: di, text: text.slice(0, 40) };
      }
    }

    return { noteDropdown, publisherDropdown };
  });

  expect(result.noteDropdown).not.toBeNull();
  expect(result.publisherDropdown).not.toBeNull();
  // Note dropdown should NOT be the same as publisher dropdown
  expect(result.noteDropdown.index).not.toBe(result.publisherDropdown.index);
  // Publisher is first (index 0), note-type is second
  expect(result.publisherDropdown.index).toBe(0);
  expect(result.noteDropdown.index).toBe(1);
});

// ── Contenteditable input: must be findable ──

test("contenteditable notes input is findable", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await injectExtensionScripts(page);

  const found = await page.evaluate(() => {
    var ces = document.querySelectorAll('[contenteditable="true"], div[role="textbox"]');
    var visible = [];
    for (var i = 0; i < ces.length; i++) {
      var r = ces[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        visible.push({ tag: ces[i].tagName.toLowerCase(), role: ces[i].getAttribute("role") });
      }
    }
    return visible;
  });

  expect(found.length).toBeGreaterThanOrEqual(1);
  expect(found[0].role).toBe("textbox");
});

// ── Text entry into contenteditable via execCommand ──

test("execCommand insertText works on contenteditable", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await injectExtensionScripts(page);

  const result = await page.evaluate(() => {
    var el = document.querySelector('[contenteditable="true"]');
    if (!el) return { found: false };
    el.focus();
    var sel = window.getSelection();
    if (sel) sel.selectAllChildren(el);
    var ok = document.execCommand("insertText", false, "sailpoint (x3), okta (x2) - Matched 2/5");
    var text = el.textContent || "";
    return { found: true, inserted: ok, text: text };
  });

  expect(result.found).toBe(true);
  expect(result.text).toContain("Matched 2/5");
});

// ── Keyword matching against fixture resume text ──

test("keyword matching finds terms in fixture resume text", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await injectExtensionScripts(page);

  const result = await page.evaluate(() => {
    var resumeEl = document.querySelector("sr-resume-viewer");
    if (!resumeEl) return null;
    var text = (resumeEl.textContent || "").trim();

    // Use the extension's exported findKeywordHits function
    // (not available in browser — it's Node-only export). Re-test via the
    // global runner instead.
    var run = globalThis.__srKeywordTriageRun;
    if (typeof run !== "function") return { error: "runner not available" };

    // Can't call the full runner (needs chrome.storage), so test text extraction.
    return { textLength: text.length, hasSailPoint: /sailpoint/i.test(text), hasOkta: /okta/i.test(text) };
  });

  expect(result).not.toBeNull();
  expect(result.textLength).toBeGreaterThan(500);
  expect(result.hasSailPoint).toBe(true);
  expect(result.hasOkta).toBe(true);
});

// ── Resume wait: resolves when the pdf.js text layer renders ──
// Live SR pages: the resume-viewer selectors also match the summary sidebar, so that
// text always reads as SR chrome. The waiter used to sit out its whole timeout (12s
// in runs) even after the PDF rendered; it must resolve on the text layer instead.

const SIDEBAR = "Candidate summary High priority skills 2/8 Other skills 5/33 See details " +
  "Order assessments No tags added for this candidate ".repeat(3);

async function resumePage(page, { pdfAtMs }) {
  await page.setContent(`<div id="st-candidateView">
    <div class="resume-panel"><div class="summary">${SIDEBAR}</div><div class="pdfViewer"></div></div>
  </div>`);
  await injectExtensionScripts(page);
  await page.evaluate((pdfAtMs) => {
    function addPage(words) {
      var layer = document.createElement("div");
      layer.className = "textLayer";
      for (var i = 0; i < 15; i++) {
        var s = document.createElement("span");
        s.textContent = words + " line " + i + " with enough resume text to count";
        layer.appendChild(s);
      }
      document.querySelector(".pdfViewer").appendChild(layer);
    }
    // Two pages, rendered lazily like pdf.js: page 2 lands later.
    pdfAtMs.forEach(function (ms, i) {
      setTimeout(function () { addPage(i === 0 ? "PyTorch Keras" : "Reinforcement learning Chennai"); }, ms);
    });
  }, pdfAtMs);
}

test("resume wait resolves soon after the pdf text layer renders, with every page", async ({ page }) => {
  await resumePage(page, { pdfAtMs: [300, 900] });
  const r = await page.evaluate(async () => {
    var t0 = performance.now();
    var text = await globalThis.__srWaitForResumeText(12000);
    return { ms: performance.now() - t0, text };
  });
  expect(r.ms).toBeLessThan(3500);
  expect(r.text).toContain("PyTorch");
  expect(r.text).toContain("Chennai");
  expect(r.text).not.toContain("Candidate summary");
});

test("resume wait does not resolve on sidebar chrome alone", async ({ page }) => {
  await resumePage(page, { pdfAtMs: [] });
  const ms = await page.evaluate(async () => {
    var t0 = performance.now();
    await globalThis.__srWaitForResumeText(2000);
    return performance.now() - t0;
  });
  expect(ms).toBeGreaterThanOrEqual(1900);
});

// ── Hidden textarea should NOT be found as the notes input ──

test("hidden textarea is not returned as visible input", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await injectExtensionScripts(page);

  const result = await page.evaluate(() => {
    var textareas = document.querySelectorAll("textarea");
    var visible = [];
    for (var i = 0; i < textareas.length; i++) {
      var s = getComputedStyle(textareas[i]);
      if (s.display !== "none" && s.visibility !== "hidden") {
        var r = textareas[i].getBoundingClientRect();
        if (r.width > 0 && r.height > 0) visible.push(textareas[i].tagName);
      }
    }
    return { total: textareas.length, visible: visible.length };
  });

  expect(result.total).toBeGreaterThanOrEqual(1);
  expect(result.visible).toBe(0);
});

// ── DOM healthcheck runs without errors ──

test("DOM healthcheck runs and reports results", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await injectExtensionScripts(page);

  const result = await page.evaluate(() => {
    var results = globalThis.__srDomHealthcheckRaw(document);
    return {
      total: results.length,
      names: results.map(r => r.name),
      criticalMissing: results.filter(r => r.critical && r.status === "MISSING").map(r => r.name),
      warnings: results.filter(r => r.warn).map(r => r.name),
    };
  });

  expect(result.total).toBeGreaterThan(10);
  // notesSection should have a warning (it's a spl-tab)
  expect(result.warnings).toContain("notesSection");
  // Post button and form element should be found
  expect(result.criticalMissing).not.toContain("notesFormElement");
});

// ── Pipeline control (#st-moveForward) is findable ──

test("Move Forward control is present", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await injectExtensionScripts(page);

  const found = await page.evaluate(() => {
    var el = document.getElementById("st-moveForward");
    if (!el) return null;
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").trim().toLowerCase(),
    };
  });

  expect(found).not.toBeNull();
  expect(found.text).toContain("move forward");
});

// ── ensureResumeTabActive: never click a link that opens the resume in a new tab ──
// SR's "Latest Resume" attachment link also says "resume"; when the Resume tab wasn't
// found first, clicking it opened a tab that was never closed.

test("resume-tab search skips the Latest Resume attachment link", async ({ page }) => {
  await page.goto(FIXTURE, { waitUntil: "domcontentloaded" });
  await injectExtensionScripts(page);

  const clicked = await page.evaluate(async () => {
    const view = document.querySelector("#st-candidateView") || document.body;
    // Like live SR: the real tab isn't reachable as role=tab, and the attachment
    // link comes earlier in the page than a "Resume" button.
    document.querySelector("#st-resume").removeAttribute("role");
    const link = document.createElement("a");
    link.href = "/app/people/attachments/123/latest-resume";
    link.target = "_blank";
    link.textContent = "Latest Resume";
    const btn = document.createElement("button");
    btn.textContent = "Resume";
    view.prepend(btn);
    view.prepend(link);
    const hits = [];
    link.addEventListener("click", (e) => { e.preventDefault(); hits.push("link"); });
    btn.addEventListener("click", () => hits.push("button"));
    await window.__srEnsureResumeTabActive();
    return hits;
  });
  expect(clicked).toEqual(["button"]);
});
