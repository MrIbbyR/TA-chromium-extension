// sr-selectors.js — Every SmartRecruiters DOM selector this extension depends on.
// When SR changes its UI, fix the selector here; no other file holds SR selectors.
//
// Loaded before every file that reads it: first content script in manifest.json,
// first file in the popup's ensure*Core injections, a <script> in popup.html, and
// importScripts() in background.js. Node tests get it through require().
//
// Provides:
//   globalThis.__SR        – { sel: { name: selector | [selectors] }, id: { name: elementId } }
//   globalThis.__SR_SEL    – the full table with descriptions (healthcheck)
//   globalThis.__srDomHealthcheck(doc?)  – validate selectors against the live DOM
//
// A selector that is an array is a priority list: callers try each entry in order.
// Code that runs through chrome.scripting.executeScript({ func }) can't see these
// globals, so the caller passes the selector in `args`.

(function () {
  "use strict";

  // ── Stable element ids (getElementById / shadow-piercing id lookup) ──
  var ID = {
    candidateView:  "st-candidateView",
    jobDetailsPage: "st-jobDetailsPage",
    moveForward:    "st-moveForward",
    screening:      "st-screening",
    notes:          "st-notes",
    applicantName:  "st-applicantName",
  };

  // ── Selector table ──────────────────────────────────────────────────
  // Each entry: { sel, desc, critical, expect?, matchText? }
  //   sel       — CSS selector string -or- array of selectors tried in order
  //   desc      — human-readable purpose (shown in healthcheck output)
  //   critical  — true if a failure here breaks a core feature
  //   expect    — optional: { notTag, notRole, tag } the matched element should have
  //   matchText — optional: healthcheck warns unless some match has this text

  var PEOPLE_LINKS = 'a[href*="/app/people/applications/"], a[href*="/app/people/profile/"], ' +
    'sr-link[href*="/app/people/applications/"], sr-link[href*="/app/people/profile/"]';
  var JOB_LIST_CONTAINERS = ["spl-table", "app-applicant-list-container",
    "app-people-tab-applicant-list-container", "people-tab-container"];

  function underJobList(containers, tails) {
    var out = [];
    for (var c = 0; c < containers.length; c++) {
      for (var t = 0; t < tails.length; t++) out.push("#" + ID.jobDetailsPage + " " + containers[c] + " " + tails[t]);
    }
    return out.join(", ");
  }

  var SEL = {

    // ── Page structure ──
    candidateView:  { sel: "#" + ID.candidateView,  desc: "Candidate view root container",     critical: true  },
    jobDetailsPage: { sel: "#" + ID.jobDetailsPage, desc: "Job details / applicant list page", critical: false },
    // Job page tabs are router links: "details/<jobId>/details", "details/<jobId>/people".
    jobDetailsTabLink: { sel: 'a[href$="/details"]', desc: "Job page: Job details tab", critical: false, matchText: "Job details" },
    jobApplicantsTabLink: { sel: 'a[href$="/people"]', desc: "Job page: Applicants tab", critical: false, matchText: "Applicants" },
    // Job details fields: li > name (".spl-text-primary", "Job Country *") + value (".spl-text-secondary").
    jobFormField: { sel: "sr-job-form-custom-fields li", desc: "Job details: one field row", critical: false },
    jobFieldName: { sel: "spl-typography-body.spl-text-primary", desc: "Job details: field name", critical: false },
    jobFieldValue: { sel: "spl-typography-body.spl-text-secondary", desc: "Job details: field value", critical: false },
    signInPassword: { sel: 'input[type="password"]', desc: "Sign-in form (logged out)",        critical: false },

    // DataDome (SR's bot protection) serves its challenge from captcha-delivery.com.
    botCheck: {
      sel: 'iframe[src*="captcha-delivery.com"], #ddChallengeBody',
      desc: "DataDome bot-check challenge",
      critical: false,
    },
    botCheckBroad: {
      sel: 'iframe[src*="captcha-delivery.com"], iframe[src*="captcha"], #ddChallengeBody',
      desc: "Any captcha challenge (preflight warning only)",
      critical: false,
    },

    // ── Pipeline controls ──
    moveForward: { sel: "#" + ID.moveForward, desc: "Move Forward pipeline button",    critical: true },
    screening:   { sel: "#" + ID.screening,   desc: "Screening questions tab/section", critical: true },
    clickable: {
      sel: 'button, [role="button"], a[href], spl-button, [class*="button"], input[type="button"], input[type="submit"]',
      desc: "Anything clickable, incl. SR spl-button hosts",
      critical: false,
    },
    screeningTabHost: {
      sel: 'button, a, [role="tab"], [role="button"], spl-tab-header, spl-link, [tabindex="0"]',
      desc: "Screening tab host that is itself clickable",
      critical: false,
    },
    screeningTabInner: {
      sel: 'button, a, [role="tab"], [role="button"], spl-button, spl-link, [tabindex="0"]',
      desc: "Clickable element inside a Screening tab host",
      critical: false,
    },
    tabTitle: {
      sel: "spl-typography-title, [class*='typography-title']",
      desc: "Tab title text (Screening label fallback)",
      critical: false,
    },
    tabClickHost: {
      sel: "button, [role='tab'], [role='button'], spl-tab",
      desc: "Clickable ancestor of a tab title",
      critical: false,
    },

    // ── Notes ──
    notesSection: {
      sel: ["#" + ID.notes, '[data-test="notes"]', "sr-notes", "app-notes"],
      desc: "Notes section (a match that is a tab is skipped)",
      critical: true,
      expect: { notTag: "spl-tab", notRole: "tab" },
    },
    notesTabLabel: {
      sel: ["a > spl-tab-label > div", "a > spl-tab-label", '[role="tab"]'],
      desc: "Profile tab labels searched for 'Notes'",
      critical: false,
    },
    tabLabel: { sel: "spl-tab-label", desc: "Profile tab label (shadow-piercing search)", critical: false },
    notesFormElement: {
      sel: '[id^="spl-form-element_"]',
      desc: "SPL form element wrapping notes input + Post button",
      critical: true,
    },
    splDropdown: {
      sel: "spl-dropdown",
      desc: "Dropdown; the note-type one reads 'Open note' / 'Note to self'",
      critical: true,
      matchText: /\bnote\b/i,
    },
    splButton: {
      sel: "spl-button",
      desc: "SR button; the notes Post button is one outside any dropdown",
      critical: true,
      matchText: /^post$/i,
    },
    dropdownMenu: { sel: "[id^='spl-dropdown-menu']", desc: "Open dropdown menu", critical: false },
    dropdownItem: { sel: "spl-dropdown-item",         desc: "Dropdown menu item (Note to self)", critical: false },
    dropdownItemClickTarget: {
      sel: ["div > spl-icon", "div > div > spl-typography-body", "div"],
      desc: "Element inside a dropdown item that takes the click",
      critical: false,
    },
    notesInput: {
      sel: '[contenteditable="true"], div[role="textbox"]',
      desc: "Notes contenteditable input (a <textarea> is also accepted)",
      critical: true,
    },

    // ── Resume viewer ──
    resumeViewer: {
      sel: ["sr-resume-viewer", "sr-candidate-resume", "sr-resume",
            '[data-testid*="resume"]', '[data-testid*="Resume"]',
            '[class*="resume"]', '[id*="resume"]'],
      desc: "Resume viewer / container",
      critical: true,
    },
    resumeScroller: {
      sel: ["sr-resume-viewer", "sr-candidate-resume", "sr-resume",
            '[data-testid*="resume"]', '[class*="resume"]', ".pdfViewer", '[class*="pdfViewer"]'],
      desc: "Resume containers scrolled to make pdf.js render every page",
      critical: false,
    },
    pdfTextLayer: {
      sel: [".textLayer span", '[class*="textLayer"] span',
            '[class*="text-layer"] span', ".pdfViewer .page .textLayer span"],
      desc: "pdf.js text layer spans (canvas-rendered resumes)",
      critical: false,
    },
    pdfTextSpans: {
      sel: '.textLayer span, [class*="textLayer"] span',
      desc: "pdf.js text spans (resume attachment tab, diagnostics count)",
      critical: false,
    },
    pdfPages: { sel: ".page, [class*='pdfViewer'] .page", desc: "pdf.js pages (diagnostics count)", critical: false },
    resumeTab: {
      sel: ['button[data-testid="resume-tab"]', 'button[data-testid="Resume"]',
            '[role="tab"]', 'a[href*="resume"]', "button"],
      desc: "Resume tab button (matched by its text)",
      critical: true,
      matchText: /resume|résumé|cv/i,
    },
    attachmentAreas: {
      sel: "sr-attachments-v2, sr-attachments-container, sr-attachment-row, sr-job-application-sidebar",
      desc: "Attachment list areas (resume attachment fallback)",
      critical: false,
    },
    attachmentAreaLinks: {
      sel: "spl-link-button, a, [role='link'], button",
      desc: "Links inside an attachment area",
      critical: false,
    },
    attachmentLinks: {
      sel: "sr-attachments-v2 a, sr-attachments-v2 spl-link-button, sr-attachment-row a, sr-attachment-row spl-link-button",
      desc: "Attachment links (diagnostics: file kinds)",
      critical: false,
    },

    // ── Candidate header ──
    applicantNameHeader: {
      sel: "#" + ID.applicantName,
      desc: "Candidate name in the profile header",
      critical: false,
    },
    candidateHeader: {
      sel: ["sr-candidate-header", '[data-testid="candidate-header"]',
            '[data-testid*="candidateHeader"]', '[class*="candidate-header"]',
            '[class*="candidateHeader"]', '[class*="candidate-name"]',
            '[class*="candidateName"]', '[data-testid*="candidate-name"]',
            "sr-candidate-summary", '[class*="candidate-summary"]',
            '[class*="candidateSummary"]'],
      desc: "Candidate header (name, title, top bar)",
      critical: false,
    },
    candidateName: {
      sel: ['[class*="candidate-name"]', '[class*="candidateName"]', '[data-testid*="candidate-name"]'],
      desc: "Candidate name fallbacks",
      critical: false,
    },
    personalInfo: {
      sel: "#" + ID.candidateView + " sr-candidate-personal-info",
      desc: "Personal-info row (location, title, phone)",
      critical: false,
    },
    personalInfoHost: { sel: "sr-candidate-personal-info", desc: "Personal-info row (shadow-piercing search)", critical: false },
    // sm:spl-flex-row omitted from the class path — it needs CSS escaping.
    personalInfoLocation: {
      sel: "div.spl-flex.spl-flex-wrap.spl-flex-col > div:nth-child(1) > spl-typography-body",
      desc: "First personal-info item: SR's location slot",
      critical: false,
    },
    personalInfoItem: { sel: "spl-typography-body", desc: "Personal-info item text", critical: false },

    // ── Profile sections ──
    profileOverview: {
      sel: ['[data-testid*="profile"]', '[data-testid*="Profile"]',
            '[class*="profile"]', '[id*="profile"]',
            '[data-testid*="overview"]', '[class*="overview"]',
            '[class*="skills"]', '[class*="summary"]',
            '[class*="experience"]', '[class*="education"]',
            "sr-candidate-profile", "sr-candidate-details",
            "sr-candidate-overview"],
      desc: "Profile overview sections (skills, experience, education)",
      critical: false,
    },

    // ── Excluded regions (stripped from keyword scan) ──
    // No bare "aside": too broad, it stripped candidate skills sections.
    excludedSidebar: {
      sel: ["sr-job-application-sidebar", "sr-job-application-details",
            "sr-job-application-overview", '[class*="job-application-sidebar"]',
            '[class*="job-application-details"]', "aside sr-job-application-sidebar"],
      desc: "Sidebar / job metadata regions excluded from keyword scan",
      critical: false,
    },

    // ── Applicant list ──
    listScroller: {
      sel: ['div[role="grid"]', 'section:has(div[role="grid"])', 'div[aria-label*="Applicants"]',
            "div.spl-scroll-y", "div.spl-scroll-container"],
      desc: "Scrollable applicant grid (autoscroll)",
      critical: false,
    },
    profileLinks: { sel: PEOPLE_LINKS, desc: "Profile links anywhere on the page", critical: false },
    jobListLinks: {
      sel: underJobList(JOB_LIST_CONTAINERS.slice(0, 2), ["a[href*='/app/people/']", "sr-link[href*='/app/people/']"]) + ", " +
           underJobList(JOB_LIST_CONTAINERS.slice(2), ["a[href*='/app/people/']"]),
      desc: "Profile links in the job's applicant table (URL harvest)",
      critical: false,
    },
    jobListClickLinks: {
      sel: underJobList(["spl-table"], ["a[href*='/app/people/applications/']", "a[href*='/app/people/profile/']",
                                        "sr-link[href*='/app/people/']"]) + ", " +
           underJobList(JOB_LIST_CONTAINERS.slice(1), ["a[href*='/app/people/']", "sr-link[href*='/app/people/']"]),
      desc: "Profile links in the job's applicant table (click mode)",
      critical: false,
    },
    jobListNames: {
      sel: underJobList(JOB_LIST_CONTAINERS.slice(1).concat("spl-table"), ["spl-typography-title spl-truncate"]),
      desc: "Applicant name cells in the job's applicant table",
      critical: false,
    },
    applicantName: {
      sel: '[data-test="applicant-name"], spl-truncate.applicant-name--name-truncate',
      desc: "Applicant name element in list view",
      critical: false,
    },
    applicantNameDeep: { sel: '[data-test="applicant-name"]', desc: "Applicant name (shadow-piercing search)", critical: false },
    jobListRowLink: { sel: "a[href*='/app/people/']", desc: "Profile link wrapping an applicant name", critical: false },
    cellProfileLink: {
      sel: 'a[href*="/app/people/"], sr-link[href*="/app/people/"], a[href^="/app/people/"]',
      desc: "Profile link in the applicant's table cell",
      critical: false,
    },
    applicantTable: { sel: "spl-table", desc: "Applicant table (rows have no <tr>)", critical: false },

    // ── Offer form (Mr Offer) ──
    offerFormBlock: {
      sel: ["spl-form-element", '[id^="spl-form-element_"]'],
      desc: "Offer form field blocks (tag, then legacy id prefix)",
      critical: false,
    },
  };

  /** @type {{ [K in keyof typeof SEL]: (typeof SEL)[K]["sel"] }} */
  var S = /** @type {any} */ ({});
  Object.keys(SEL).forEach(function (k) { /** @type {any} */ (S)[k] = /** @type {any} */ (SEL)[k].sel; });
  var SR = { sel: S, id: ID };

  // ── Healthcheck ─────────────────────────────────────────────────────

  function isVisible(el) {
    if (!el) return false;
    try {
      var s = (el.ownerDocument.defaultView || window).getComputedStyle(el);
      if (!s || s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (_) { return false; }
  }

  function getDeepText(el) {
    var t = "";
    try { t = (el.textContent || el.innerText || "").replace(/\s+/g, " ").trim(); } catch (_) {}
    if (!t && el.shadowRoot) {
      try { t = (el.shadowRoot.textContent || "").replace(/\s+/g, " ").trim(); } catch (_) {}
    }
    return t;
  }

  function queryFirst(doc, selOrArray) {
    var sels = Array.isArray(selOrArray) ? selOrArray : [selOrArray];
    for (var i = 0; i < sels.length; i++) {
      try {
        var el = doc.querySelector(sels[i]);
        if (el) return { el: el, selector: sels[i] };
      } catch (_) {}
    }
    return null;
  }

  function queryAll(doc, selOrArray) {
    var sels = Array.isArray(selOrArray) ? selOrArray : [selOrArray];
    var out = [];
    for (var i = 0; i < sels.length; i++) {
      try {
        var els = doc.querySelectorAll(sels[i]);
        for (var j = 0; j < els.length; j++) out.push({ el: els[j], selector: sels[i] });
      } catch (_) {}
    }
    return out;
  }

  function runHealthcheck(doc) {
    doc = doc || document;
    var results = [];
    var keys = Object.keys(SEL);

    for (var k = 0; k < keys.length; k++) {
      var name = keys[k];
      var entry = SEL[name];
      var found = queryFirst(doc, entry.sel);
      var allFound = queryAll(doc, entry.sel);
      var status = "MISSING";
      var detail = "";
      var warn = false;

      if (found) {
        var el = found.el;
        var tag = (el.tagName || "").toLowerCase();
        var role = el.getAttribute ? el.getAttribute("role") : null;
        var vis = isVisible(el);
        var hasShadow = !!el.shadowRoot;
        status = vis ? "OK" : "HIDDEN";
        detail = "<" + tag + "> via " + found.selector + " (visible=" + vis + ", shadow=" + hasShadow + ", count=" + allFound.length + ")";

        if (entry.expect) {
          if (entry.expect.notTag && tag === entry.expect.notTag) {
            warn = true;
            detail += " ⚠ UNEXPECTED TAG (expected NOT " + entry.expect.notTag + ")";
          }
          if (entry.expect.notRole && role === entry.expect.notRole) {
            warn = true;
            detail += " ⚠ UNEXPECTED ROLE (expected NOT " + entry.expect.notRole + ")";
          }
          if (entry.expect.tag && tag !== entry.expect.tag) {
            warn = true;
            detail += " ⚠ WRONG TAG (expected " + entry.expect.tag + ", got " + tag + ")";
          }
        }

        if (entry.matchText) {
          var foundTextMatch = false;
          for (var ai = 0; ai < allFound.length; ai++) {
            if (entry.matchText.test(getDeepText(allFound[ai].el))) { foundTextMatch = true; break; }
          }
          if (!foundTextMatch) {
            warn = true;
            detail += " ⚠ NO ELEMENT MATCHES TEXT " + entry.matchText;
          }
        }
      }

      results.push({
        name: name,
        desc: entry.desc,
        critical: !!entry.critical,
        status: status,
        warn: warn,
        detail: detail,
      });
    }

    return results;
  }

  function printHealthcheck(doc) {
    var results = runHealthcheck(doc);
    var missing = 0;
    var warnings = 0;

    console.log("%c SR DOM Healthcheck ", "background:#1a1a2e;color:#6ea8ff;font-size:14px;font-weight:bold;padding:4px 8px;border-radius:4px");
    console.log("");

    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var icon = r.status === "OK" ? "✓" : r.status === "HIDDEN" ? "◌" : "✗";
      var color = r.status === "OK" && !r.warn ? "color:#4caf50" : r.status === "MISSING" ? "color:#f44336" : "color:#ff9800";
      var crit = r.critical ? " [CRITICAL]" : "";
      console.log(
        "%c" + icon + " " + r.name + "%c " + r.desc + crit + (r.detail ? "\n    " + r.detail : ""),
        color + ";font-weight:bold", "color:inherit"
      );
      if (r.status === "MISSING") missing++;
      if (r.warn) warnings++;
    }

    console.log("");
    var summary = results.length + " selectors checked — " + missing + " missing, " + warnings + " warnings";
    var critMissing = results.filter(function (r) { return r.critical && r.status === "MISSING"; });
    if (critMissing.length) {
      summary += " — " + critMissing.length + " CRITICAL MISSING: " + critMissing.map(function (r) { return r.name; }).join(", ");
    }
    console.log("%c" + summary, missing > 0 || warnings > 0 ? "color:#ff9800;font-weight:bold" : "color:#4caf50");

    return { total: results.length, missing: missing, warnings: warnings, criticalMissing: critMissing.length, results: results };
  }

  // ── Exports ──────────────────────────────────────────────────────────

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { SR: SR, SEL: SEL, ID: ID, runHealthcheck: runHealthcheck };
  }

  globalThis.__SR = SR;
  globalThis.__SR_SEL = SEL;
  globalThis.__srDomHealthcheck = printHealthcheck;
  globalThis.__srDomHealthcheckRaw = runHealthcheck;

  // Bridge for sr-healthcheck-main-world.js (MAIN world content script), so typing
  // __srDomHealthcheck() in the DevTools console works. SR pages only (not the
  // popup or the service worker), and once per frame — the popup re-injects this file.
  if (typeof document !== "undefined" && typeof location !== "undefined" &&
      /smartrecruiters\.com$/i.test(location.hostname || "") && !globalThis.__srHealthcheckBridge) {
    globalThis.__srHealthcheckBridge = true;
    document.addEventListener("__sr_healthcheck_request", function () {
      var result = printHealthcheck(document);
      document.dispatchEvent(new CustomEvent("__sr_healthcheck_response", {
        detail: JSON.stringify(result),
      }));
    });
  }

})();
