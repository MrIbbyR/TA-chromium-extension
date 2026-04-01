// salary-triage-core.js — SmartRecruiters screening salary check + optional Move click
// Exposes: __srSalaryTriageRun, __srSalaryTriageRunMulti (queue), __srSalaryTriageRunOrSkip (per-frame),
//          __srSalaryTriageDiagnose (optional / console), __srSalaryTriageStartQueue, __srCollectApplicantClickTargets

(function () {
  "use strict";

  const DEFAULT_QUESTION_HINTS = [
    // English
    "expected salary",
    "desired salary",
    "salary expectation",
    "salary expectations",
    "salary rate",
    "specify your salary expectations",
    "please specify your salary",
    "salary expectations in the currency",
    "compensation expectation",
    "expected compensation",
    "salary expect",
    "what is your expected",
    "pay expectation",
    "remuneration",
    "gross per year",
    "gross per annum",
    "currency of the country",
    "currency of the country you re applying",
    "applying for gross",
    "preferred local currency",
    "desired salary rate",
    "annual expected ctc",
    "expected ctc in inr",
    "expected ctc",
    "annual ctc in inr",
  ];

  /** Non-English salary/compensation keywords for fallback matching across markets. */
  const INTL_SALARY_KEYWORDS = [
    // Turkish
    "maaş", "maaş beklentisi", "ücret", "ücret beklentisi",
    // German
    "gehalt", "gehaltsvorstellung", "vergütung", "bruttojahresgehalt",
    // French
    "salaire", "rémunération", "prétentions salariales",
    // Spanish
    "salario", "remuneración", "expectativa salarial", "sueldo",
    // Portuguese
    "salário", "remuneração", "pretensão salarial",
    // Italian
    "stipendio", "retribuzione", "ral",
    // Dutch
    "salaris", "salarisverw",
    // Polish
    "wynagrodzenie", "oczekiwania finansowe",
    // Czech / Slovak
    "plat", "mzda", "mzdové",
    // Romanian
    "salariu", "așteptări salariale",
    // Bulgarian
    "заплата", "възнаграждение",
    // Russian / Ukrainian
    "зарплата", "оклад", "заробітна",
    // Arabic
    "راتب", "الراتب المتوقع",
    // Hindi
    "वेतन", "अपेक्षित वेतन",
    // Chinese
    "薪资", "期望薪资", "薪酬",
    // Japanese
    "給与", "希望年収",
    // Korean
    "급여", "희망연봉",
    // Thai
    "เงินเดือน",
    // Malay / Indonesian
    "gaji",
  ];

  const SCREENING_TAB_ID = "st-screening";
  const MOVE_FORWARD_ID = "st-moveForward";

  const CERT_START = /^i\s+certify\s+that\s+to\s+the\s+best\s+of\s+my\s+knowledge/i;
  const Q_START = /^(please|specify|provide|enter|select|choose|state|list|give|what|which|when|where|how|are\s+you|do\s+you|did\s+you|have\s+you|i\s+certify|lütfen|bitte|veuillez|por\s+favor|indique|geben|inserisci|podaj|uveďte|введите|يرجى|कृपया|请|ご)/i;

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /** Lowercase + collapse whitespace, preserving Unicode letters (accents, CJK, Cyrillic, Arabic…). */
  function normText(s) {
    try {
      return String(s || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    } catch (_) {
      return String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u0E00-\u0E7F\u3000-\u9FFF\uAC00-\uD7AF]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  function isVisible(el, win) {
    if (!el) return false;
    const style = win.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0)
      return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isDisabledish(el) {
    if (!el) return true;
    try {
      if (el.disabled === true) return true;
    } catch (_) {}
    try {
      if (el.getAttribute && el.getAttribute("disabled") != null) return true;
      if (String(el.getAttribute && el.getAttribute("aria-disabled")).toLowerCase() === "true") return true;
    } catch (_) {}
    return false;
  }

  function walkShadow(node, visitor, visited) {
    if (!node || visited.has(node)) return;
    visited.add(node);
    visitor(node);
    if (node.childNodes && node.childNodes.length) {
      for (let i = 0; i < node.childNodes.length; i++) walkShadow(node.childNodes[i], visitor, visited);
    }
    const sr = node.shadowRoot;
    if (sr) walkShadow(sr, visitor, visited);
  }

  function queryDeepSelectorAll(root, win, selector) {
    const out = [];
    const visited = new Set();
    walkShadow(
      root,
      function (n) {
        if (n.nodeType === 1) {
          try {
            if (n.matches && n.matches(selector)) out.push(n);
            out.push.apply(out, Array.from(n.querySelectorAll(selector)));
          } catch (_) {}
        }
      },
      visited
    );
    return out.filter(function (el, i, a) {
      return a.indexOf(el) === i;
    });
  }

  function collectClickablesDeep(root, win) {
    const sel =
      'button, [role="button"], a[href], spl-button, [class*="button"], input[type="button"], input[type="submit"]';
    const raw = queryDeepSelectorAll(root, win, sel);
    return raw.filter(function (el) {
      return isVisible(el, win);
    });
  }

  function getDeepText(el) {
    let out = "";
    const visited = new Set();
    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 3) {
        out += node.nodeValue || "";
        return;
      }
      if (node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
      }
      if (node.shadowRoot) walk(node.shadowRoot);
    }
    walk(el);
    return out;
  }

  function looksLikeQuestion(s) {
    s = String(s || "").trim();
    if (!s) return false;
    if (/[?:]\s*$/.test(s)) return true;
    return Q_START.test(s);
  }

  /** Find #st-screening across light DOM + open shadow roots (getElementById does not pierce shadow). */
  function findElementByIdDeep(root, id, visited) {
    if (!visited) visited = new Set();
    if (!root || visited.has(root)) return null;
    visited.add(root);
    if (root.nodeType === 1) {
      try {
        if (root.id === id) return root;
        if (root.getAttribute && root.getAttribute("id") === id) return root;
      } catch (_) {}
    }
    if (root.childNodes) {
      for (let i = 0; i < root.childNodes.length; i++) {
        const f = findElementByIdDeep(root.childNodes[i], id, visited);
        if (f) return f;
      }
    }
    if (root.shadowRoot) {
      const f = findElementByIdDeep(root.shadowRoot, id, visited);
      if (f) return f;
    }
    return null;
  }

  function findStScreeningEl(doc) {
    let el = null;
    try {
      el = doc.getElementById(SCREENING_TAB_ID);
    } catch (_) {}
    if (el) return el;
    return findElementByIdDeep(doc.documentElement || doc.body, SCREENING_TAB_ID);
  }

  /** Best element to click inside a tab host (SR uses custom elements). */
  function screeningClickTarget(host) {
    if (!host) return null;
    try {
      if (
        host.matches &&
        host.matches('button, a, [role="tab"], [role="button"], spl-tab-header, spl-link, [tabindex="0"]')
      ) {
        return host;
      }
    } catch (_) {}
    const inner = host.querySelector(
      'button, a, [role="tab"], [role="button"], spl-button, spl-link, [tabindex="0"]'
    );
    return inner || host;
  }

  async function clickEl(win, el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: "center", behavior: "instant" });
    } catch (_) {}
    await sleep(40);
    try {
      el.click();
    } catch (_) {
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
    }
  }

  /** True when pathname is a single-candidate profile (not the Applicants table). */
  function isCandidateProfilePage(doc) {
    try {
      const p = (doc.location && doc.location.pathname) || "";
      return /\/app\/people\/(?:applications|profile)\/[^/?#]+/i.test(p);
    } catch (_) {
      return false;
    }
  }

  /** Walk up light DOM + shadow hosts so we can test tablist containment for slotted/shadow nodes. */
  function isDescendantOrShadowDescendant(ancestor, el) {
    let n = el;
    for (let i = 0; i < 50 && n; i++) {
      if (n === ancestor) return true;
      const root = n.getRootNode && n.getRootNode();
      if (root && root instanceof ShadowRoot) {
        n = root.host;
        continue;
      }
      n = n.parentElement;
    }
    return false;
  }

  function allTabLists(doc, win) {
    const out = [];
    const seen = new Set();
    function add(el) {
      if (el && !seen.has(el)) {
        seen.add(el);
        out.push(el);
      }
    }
    try {
      doc.querySelectorAll('[role="tablist"]').forEach(add);
    } catch (_) {}
    try {
      queryDeepSelectorAll(doc.body || doc.documentElement, win, '[role="tablist"]').forEach(add);
    } catch (_) {}
    return out;
  }

  function elementInAnyTabList(el, lists) {
    for (let i = 0; i < lists.length; i++) {
      if (isDescendantOrShadowDescendant(lists[i], el)) return true;
    }
    return false;
  }

  /**
   * Only click "More" inside the horizontal tab strip — never random "More" elsewhere (sidebar, filters).
   */
  async function openMoreOverflowMenuInTabStrip(doc, win, log) {
    const lists = allTabLists(doc, win);
    if (!lists.length) return false;
    const clickables = collectClickablesDeep(doc.body || doc.documentElement, win);
    for (let i = 0; i < clickables.length; i++) {
      const el = clickables[i];
      if (!elementInAnyTabList(el, lists)) continue;
      const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
      const txt = raw.toLowerCase();
      if (!txt) continue;
      if (/more\s+actions/i.test(txt)) continue;
      if (txt === "more" || (/^more\b/i.test(raw) && raw.length <= 32)) {
        await clickEl(win, el);
        await sleep(250);
        if (log) log.push({ ok: true, msg: 'Tab row: opened "More"' });
        return true;
      }
    }
    return false;
  }

  async function clickScreeningLabelInTabStrip(doc, win, log) {
    const lists = allTabLists(doc, win);
    if (!lists.length) return false;
    const clickables = collectClickablesDeep(doc.body || doc.documentElement, win);
    for (let i = 0; i < clickables.length; i++) {
      const el = clickables[i];
      if (!elementInAnyTabList(el, lists)) continue;
      const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (/^screening$/i.test(raw)) {
        await clickEl(win, el);
        await sleep(250);
        log.push({ ok: true, msg: "Screening (tab strip label)" });
        return true;
      }
    }
    return false;
  }

  function isEffectivelyHidden(el, win) {
    if (!el) return true;
    const st = win.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) return true;
    const r = el.getBoundingClientRect();
    return r.width < 2 && r.height < 2;
  }

  async function tryClickStScreening(doc, win, log, sourceTag, allowHiddenClick) {
    const host = findStScreeningEl(doc);
    if (!host) return false;
    const target = screeningClickTarget(host);
    if (!target) return false;
    const hostHidden = isEffectivelyHidden(host, win);
    const targetHidden = isEffectivelyHidden(target, win);
    if (hostHidden && targetHidden && !allowHiddenClick) return false;
    await clickEl(win, target);
    await sleep(250);
    log.push({ ok: true, msg: "Opened Screening (" + sourceTag + ")" });
    return true;
  }

  async function clickScreeningTab(doc, win, log) {
    let moreOpened = false;
    const tries = 55;

    for (let t = 0; t < tries; t++) {
      if (await tryClickStScreening(doc, win, log, "#st-screening", false)) return true;

      if (findStScreeningEl(doc) && (await tryClickStScreening(doc, win, log, "#st-screening (force)", true)))
        return true;

      if (await clickScreeningLabelInTabStrip(doc, win, log)) return true;

      if (!moreOpened && t >= 8 && t % 12 === 0 && !findStScreeningEl(doc)) {
        const opened = await openMoreOverflowMenuInTabStrip(doc, win, log);
        if (opened) moreOpened = true;
        if (await tryClickStScreening(doc, win, log, "#st-screening after More", false)) return true;
        if (findStScreeningEl(doc) && (await tryClickStScreening(doc, win, log, "#st-screening after More (force)", true)))
          return true;
        if (await clickScreeningLabelInTabStrip(doc, win, log)) return true;
      }

      const lists = allTabLists(doc, win);
      const titles = queryDeepSelectorAll(
        doc.body || doc.documentElement,
        win,
        "spl-typography-title, [class*='typography-title']"
      );
      for (let j = 0; j < titles.length; j++) {
        const el = titles[j];
        if (lists.length && !elementInAnyTabList(el, lists)) continue;
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (/^screening$/i.test(txt)) {
          const clickHost = el.closest("button, [role='tab'], [role='button'], spl-tab") || el.parentElement || el;
          await clickEl(win, clickHost);
          await sleep(250);
          log.push({ ok: true, msg: "Opened Screening (typography in tab area)" });
          return true;
        }
      }

      await sleep(120);
    }

    log.push({
      ok: false,
      msg: "Could not open Screening — open a candidate profile (not the Applicants table), then run again.",
    });
    return false;
  }

  function findScreeningSectionRoot(doc, win) {
    const body = doc.body || doc.documentElement;
    let found = null;
    const visited = new Set();
    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 1) {
        const t = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (/screening questions/i.test(t) && t.length < 2500) {
          let el = node;
          for (let up = 0; up < 18 && el; up++) {
            const tag = (el.tagName || "").toLowerCase();
            if (tag === "section" || tag.indexOf("card") >= 0 || tag === "spl-card") {
              found = el;
              return;
            }
            el = el.parentElement;
          }
          found = node;
        }
      }
      if (node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
      }
      if (node.shadowRoot) walk(node.shadowRoot);
    }
    walk(body);
    if (found) return found;
    const sections = queryDeepSelectorAll(body, win, "section");
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      if (/screening/i.test(s.textContent || "")) return s;
    }
    return body;
  }

  function getScreeningPairs(doc, win) {
    const root = findScreeningSectionRoot(doc, win);
    if (!root) return [];
    const texts = [];
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const t = String(node.nodeValue || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!t) continue;
      if (/^last edit was made/i.test(t)) continue;
      if (/^see versions$/i.test(t)) continue;
      if (/^screening questions$/i.test(t)) continue;
      texts.push(t);
    }

    const pairs = [];
    let q = null;
    let ans = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (CERT_START.test(t)) {
        if (q) pairs.push([q, ans.join(" ").trim()]);
        q = null;
        ans = [];
        continue;
      }
      if (looksLikeQuestion(t)) {
        if (q) pairs.push([q, ans.join(" ").trim()]);
        q = t;
        ans = [];
      } else {
        if (q) ans.push(t);
      }
    }
    if (q) pairs.push([q, ans.join(" ").trim()]);

    const out = [];
    for (let p = 0; p < pairs.length; p++) {
      const qq = pairs[p][0];
      const aa = pairs[p][1];
      if (CERT_START.test(qq)) continue;
      out.push([qq.replace(/[:?\s]+$/, "").replace(/\s+/g, " ").trim(), (aa || "").replace(/\s+/g, " ").trim()]);
    }
    return out;
  }

  function parseHints(config) {
    const extra = String(config.questionHints || "")
      .split(/[,;\n]+/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
    return DEFAULT_QUESTION_HINTS.concat(INTL_SALARY_KEYWORDS).concat(extra).map(normText);
  }

  /** Check if normalized question text contains any international salary keyword. */
  function hasIntlSalaryKeyword(qNorm) {
    for (let i = 0; i < INTL_SALARY_KEYWORDS.length; i++) {
      var kw = normText(INTL_SALARY_KEYWORDS[i]);
      if (kw && qNorm.indexOf(kw) >= 0) return true;
    }
    return false;
  }

  function isExpectedCtcQuestionNorm(qNorm) {
    if (!qNorm || qNorm.indexOf("expected") < 0) return false;
    if (qNorm.indexOf("ctc") >= 0) return true;
    if (qNorm.indexOf("cost") >= 0 && qNorm.indexOf("company") >= 0) return true;
    return false;
  }

  function isCurrentOnlyCtcQuestionNorm(qNorm) {
    if (!qNorm || qNorm.indexOf("current") < 0) return false;
    if (qNorm.indexOf("expected") >= 0) return false;
    if (qNorm.indexOf("ctc") >= 0) return true;
    return qNorm.indexOf("cost") >= 0 && qNorm.indexOf("company") >= 0;
  }

  function scoreQuestion(qNorm, hints) {
    let best = 0;
    for (let i = 0; i < hints.length; i++) {
      const h = hints[i];
      if (!h) continue;
      if (qNorm.includes(h) || h.includes(qNorm)) {
        best = Math.max(best, 0.85);
        continue;
      }
      const hw = h.split(" ").filter(Boolean);
      const qw = qNorm.split(" ").filter(Boolean);
      let o = 0;
      for (let a = 0; a < hw.length; a++) {
        if (qw.indexOf(hw[a]) >= 0) o++;
      }
      if (hw.length) best = Math.max(best, o / hw.length);
    }
    return best;
  }

  function pickSalaryPair(pairs, hintsNorm) {
    let pool = pairs;
    const anyExpectedCtc = pairs.some(function (p) {
      return isExpectedCtcQuestionNorm(normText(p[0]));
    });
    if (anyExpectedCtc) {
      const onlyExp = pairs.filter(function (p) {
        return isExpectedCtcQuestionNorm(normText(p[0]));
      });
      if (onlyExp.length) pool = onlyExp;
    }

    let bestPair = null;
    let bestScore = 0;
    for (let i = 0; i < pool.length; i++) {
      const qn = normText(pool[i][0]);
      const sc = scoreQuestion(qn, hintsNorm);
      if (sc > bestScore) {
        bestScore = sc;
        bestPair = pool[i];
      }
    }
    if (bestPair && bestScore >= 0.28) return bestPair;

    let fbPair = null;
    let fbScore = 0;
    for (let j = 0; j < pool.length; j++) {
      const qRaw = pool[j][0] || "";
      const qn = normText(qRaw);
      if (!qn) continue;
      if (anyExpectedCtc && isCurrentOnlyCtcQuestionNorm(qn)) continue;
      const hasSalary =
        /\bsalary\b/.test(qn) ||
        /\bcompensation\b/.test(qn) ||
        /\bremuneration\b/.test(qn) ||
        /\bctc\b/.test(qn) ||
        hasIntlSalaryKeyword(qn);
      if (!hasSalary) continue;
      let sc2 = 0.25;
      if (qn.indexOf("expect") >= 0) sc2 += 0.35;
      if (qn.indexOf("specify") >= 0) sc2 += 0.3;
      if (qn.indexOf("gross") >= 0) sc2 += 0.25;
      if (qn.indexOf("currency") >= 0) sc2 += 0.2;
      if (qn.indexOf("please") >= 0) sc2 += 0.1;
      if (qn.indexOf("per year") >= 0 || qn.indexOf("annum") >= 0) sc2 += 0.15;
      if (qn.indexOf("ctc") >= 0) sc2 += 0.35;
      if (qn.indexOf("expected") >= 0) sc2 += 0.4;
      if (qn.indexOf("desired") >= 0) sc2 += 0.35;
      if (qn.indexOf("inr") >= 0) sc2 += 0.1;
      if (hasIntlSalaryKeyword(qn)) sc2 += 0.35;
      if (sc2 > fbScore) {
        fbScore = sc2;
        fbPair = pool[j];
      }
    }
    if (fbPair && fbScore >= 0.55) return fbPair;
    if (bestPair && bestScore >= 0.2) return bestPair;
    return fbPair;
  }

  /**
   * Parse money from screening answers: Western commas, Indian lakhs grouping (30,00,000),
   * ranges with "to", INR/CTC tokens, 25L = 25 lakhs, "20 lakhs", k = thousand.
   */
  function parseSalaryNumber(text) {
    const s0 = String(text || "").trim();
    if (!s0) return null;
    let s = s0.replace(/\u2013|\u2014/g, "-");
    const lower = s.toLowerCase();

    let wordMult = 1;
    if (/\bcr(?:ore)?s?\b/.test(lower)) wordMult = 10000000;
    else if (/\blakhs?\b|\blacs?\b/.test(lower)) wordMult = 100000;
    else if (/\bmillion\b|\bmn\b/.test(lower)) wordMult = 1000000;

    let kMult = 1;
    if (/\d\s*k\b/i.test(lower) || /\d+k\b/i.test(lower.replace(/,/g, ""))) kMult = 1000;

    let work = s.replace(/(\d+(?:\.\d+)?)\s*[lL]\b/g, function (_, n) {
      return String(Math.round(parseFloat(n) * 100000));
    });

    work = work
      .replace(/\b(eur|euros?|€|usd|\$|gbp|£|inr|₹|myr|rm|bgn|leva|ctc)\b/gi, " ")
      .replace(/\blakhs?\b|\blacs?\b/gi, " ")
      .replace(/\bcr(?:ore)?s?\b/gi, " ")
      .replace(/\bmillion\b|\bmn\b/gi, " ");

    work = work.replace(/,/g, "");

    const nums = [];
    const re = /(\d+(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(work))) {
      const v = parseFloat(m[1]);
      if (isFinite(v)) nums.push(v);
    }
    if (!nums.length) return null;

    const rangeLike =
      /\d+\s*[-–—]\s*\d+/.test(s0) ||
      /\d+\s+to\s+\d+/i.test(lower) ||
      /\bbetween\b/i.test(lower);

    if (nums.length >= 2 && rangeLike) {
      return Math.max.apply(null, nums) * wordMult * kMult;
    }
    return nums[nums.length - 1] * wordMult * kMult;
  }

  /** Max/min budget fields in the popup: same rules as answers (e.g. 35L, 3500000, 35,00,000). */
  function parseBudgetAmount(raw) {
    if (raw == null) return NaN;
    const t = String(raw).trim();
    if (t === "") return NaN;
    const p = parseSalaryNumber(t);
    if (p != null && isFinite(p)) return p;
    return parseFloat(t.replace(/,/g, ""));
  }

  /**
   * SR split buttons often put the real <button> inside shadow DOM; host.querySelector misses it.
   * Prefer a visible control whose text includes "Move forward" (not the chevron-only segment).
   */
  function resolveMoveForwardClickTarget(doc, win, host) {
    if (!host) return null;
    let candidates = [];
    try {
      candidates = queryDeepSelectorAll(host, win, 'button, [role="button"], a[href]');
    } catch (_) {
      candidates = [];
    }
    try {
      if (host.matches && host.matches('button, [role="button"], a[href]')) candidates.unshift(host);
    } catch (_) {}

    let bestForward = null;
    let bestLen = 1e9;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (isDisabledish(el)) continue;
      if (!isVisible(el, win)) continue;
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!/\bmove\s+forward\b/.test(txt)) continue;
      if (txt.length < bestLen) {
        bestLen = txt.length;
        bestForward = el;
      }
    }
    if (bestForward) return bestForward;

    for (let j = 0; j < candidates.length; j++) {
      const el = candidates[j];
      if (isDisabledish(el)) continue;
      if (!isVisible(el, win)) continue;
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (txt.length > 0 && txt.length < 100) return el;
    }

    try {
      if (!isDisabledish(host) && isVisible(host, win) && host.matches && host.matches('button, [role="button"], a[href]'))
        return host;
    } catch (_) {}
    return host;
  }

  /** Synthetic click with coordinates — SR spl-button often expects PointerEvent + native .click(). */
  function dispatchClickAtElementCenter(el, win, xBias) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const bias = typeof xBias === "number" ? xBias : 0.35;
    const x = r.left + Math.max(4, Math.min(r.width * bias, r.width - 4));
    const y = r.top + r.height / 2;
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: win, button: 0 };
    try {
      if (typeof win.PointerEvent === "function") {
        el.dispatchEvent(
          new win.PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            view: win,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
            buttons: 1,
          })
        );
      }
    } catch (_) {}
    try {
      el.dispatchEvent(new win.MouseEvent("pointerdown", base));
    } catch (_) {}
    try {
      el.dispatchEvent(new win.MouseEvent("mousedown", base));
    } catch (_) {}
    try {
      el.dispatchEvent(new win.MouseEvent("mouseup", base));
    } catch (_) {}
    try {
      if (typeof win.PointerEvent === "function") {
        el.dispatchEvent(
          new win.PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            view: win,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
            buttons: 0,
          })
        );
      }
    } catch (_) {}
    try {
      el.dispatchEvent(new win.MouseEvent("pointerup", base));
    } catch (_) {}
    try {
      el.dispatchEvent(new win.MouseEvent("click", base));
    } catch (_) {}
  }

  /** Inner native button + spl-button host (listeners often on the custom element). */
  function fireMoveForwardPipelineClick(win, innerBtn, host) {
    if (!innerBtn) return;
    dispatchClickAtElementCenter(innerBtn, win, 0.32);
    try {
      if (typeof innerBtn.click === "function") innerBtn.click();
    } catch (_) {}

    if (!host || host === innerBtn) return;
    const tag = (host.tagName || "").toLowerCase();
    if (tag.indexOf("spl-") !== 0 && !host.shadowRoot) return;

    dispatchClickAtElementCenter(host, win, 0.32);
    try {
      if (typeof host.click === "function") host.click();
    } catch (_) {}
  }

  function findMoveControl(doc, win, includesText) {
    const needle = String(includesText || "").trim().toLowerCase();

    let host = null;
    try {
      host = doc.getElementById(MOVE_FORWARD_ID);
    } catch (_) {}
    if (!host) {
      try {
        host = findElementByIdDeep(doc.documentElement || doc.body, MOVE_FORWARD_ID);
      } catch (_) {}
    }
    if (host) {
      const target = resolveMoveForwardClickTarget(doc, win, host);
      const blob = ((target && target.textContent) || host.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (needle && blob && !blob.includes(needle)) {
        /* optional hint mismatch: still use #st-moveForward — SR labels are consistent */
      }
      return target || host;
    }

    const clickables = collectClickablesDeep(doc.body || doc.documentElement, win);
    let bestForward = null;
    let bestForwardLen = 1e9;
    let fallback = null;
    let fallbackLen = 1e9;

    for (let i = 0; i < clickables.length; i++) {
      const el = clickables[i];
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!txt) continue;
      if (needle && txt.includes(needle)) return el;
      if (needle) continue;
      if (txt.length > 120) continue;
      if (/\bmove\s+forward\b/.test(txt)) {
        if (txt.length < bestForwardLen) {
          bestForwardLen = txt.length;
          bestForward = el;
        }
      } else if (/\bmove\b/.test(txt)) {
        if (txt.length < fallbackLen) {
          fallbackLen = txt.length;
          fallback = el;
        }
      }
    }
    return bestForward || fallback;
  }

  function hasSrProfileChrome(doc) {
    if (!doc) return false;
    let mv = null;
    try {
      mv = doc.getElementById(MOVE_FORWARD_ID);
    } catch (_) {}
    if (!mv) {
      try {
        mv = findElementByIdDeep(doc.documentElement || doc.body, MOVE_FORWARD_ID);
      } catch (_) {}
    }
    return !!(mv || findStScreeningEl(doc));
  }

  async function runSalaryTriageWithDoc(doc, win, config, options) {
    options = options || {};
    const log = [];
    const subframeTriage = !!options.subframeTriage;

    if (!isCandidateProfilePage(doc) && !subframeTriage) {
      log.push({
        ok: false,
        msg: "Wrong page — open one candidate from Applicants (click the name). Screening only exists on /app/people/applications/…",
      });
      return { log, moved: false, skipped: true, amount: null, inBudget: null };
    }

    const maxSalary = parseBudgetAmount(config.maxSalary);
    let minSalary = 0;
    if (config.minSalary != null && String(config.minSalary).trim() !== "") {
      const m = parseBudgetAmount(config.minSalary);
      if (isFinite(m)) minSalary = m;
    }
    const dryRun = !!config.dryRun;
    const moveIncludes = String(config.moveButtonIncludes || "").trim();

    if (!isFinite(maxSalary) || maxSalary <= 0) {
      log.push({ ok: false, msg: "Invalid max budget (use same units as screening answers, e.g. 3500000 or 35L)" });
      return { log, moved: false, skipped: true, amount: null, inBudget: null };
    }

    const hintsNorm = parseHints(config);
    const opened = await clickScreeningTab(doc, win, log);
    if (!opened) {
      return { log, moved: false, skipped: true, amount: null, inBudget: null };
    }

    var baseWait = parseInt(config.screeningWaitMs, 10) || 600;
    var minWait = Math.max(250, Math.min(baseWait, 600));
    await sleep(minWait);

    var pairsMaxWait = Math.max(baseWait, 3500);
    var pollStep = 150;
    var pairs = [];
    var pollStart = Date.now();
    while (Date.now() - pollStart < pairsMaxWait) {
      try {
        pairs = getScreeningPairs(doc, win);
      } catch (e) {
        pairs = [];
      }
      if (pairs.length >= 2) break;
      if (pairs.length === 1 && (Date.now() - pollStart) >= 600) break;
      await sleep(pollStep);
    }
    if (pairs.length === 0) {
      try {
        pairs = getScreeningPairs(doc, win);
      } catch (e) {
        log.push({ ok: false, msg: "Screening parse error: " + (e && e.message) });
        return { log, moved: false, skipped: true, amount: null, inBudget: null };
      }
    }

    log.push({ ok: true, msg: "Screening Q&A blocks: " + pairs.length + " (waited " + (Date.now() - pollStart) + "ms)" });

    const picked = pickSalaryPair(pairs, hintsNorm);
    if (!picked) {
      log.push({ ok: false, msg: "No salary-like screening question matched" });
      return { log, moved: false, skipped: true, amount: null, inBudget: null };
    }

    const qPretty = picked[0];
    const answer = picked[1];
    log.push({ ok: true, msg: "Q: " + qPretty.slice(0, 120) + (qPretty.length > 120 ? "…" : "") });
    log.push({ ok: true, msg: "A: " + (answer || "(empty)").slice(0, 120) });

    const amount = parseSalaryNumber(answer);
    if (amount == null || !isFinite(amount)) {
      log.push({ ok: false, msg: "Could not parse a number from answer" });
      return { log, moved: false, skipped: true, amount: null, inBudget: null };
    }

    log.push({ ok: true, msg: "Parsed amount: " + amount });

    const inBudget = amount >= minSalary && amount <= maxSalary;
    log.push({
      ok: true,
      msg: inBudget ? "Within budget (" + minSalary + "–" + maxSalary + ")" : "Outside budget — skip Move",
    });

    if (!inBudget) {
      return { log, moved: false, skipped: false, amount: amount, inBudget: false };
    }

    if (dryRun) {
      log.push({ ok: true, msg: "Dry run: would click Move forward (skipped)" });
      return { log, moved: false, skipped: false, amount: amount, inBudget: true };
    }

    const moveSettleMs = Math.max(300, parseInt(config.moveSettleMs, 10) || 700);
    const moveReadyMs = Math.max(500, parseInt(config.moveButtonReadyMs, 10) || 2500);
    const step = 150;

    let moveHost = null;
    let btn = null;
    for (let elapsed = 0; elapsed < moveReadyMs; elapsed += step) {
      try {
        moveHost = doc.getElementById(MOVE_FORWARD_ID);
      } catch (_) {}
      if (!moveHost) {
        try {
          moveHost = findElementByIdDeep(doc.documentElement || doc.body, MOVE_FORWARD_ID);
        } catch (_) {}
      }
      btn = findMoveControl(doc, win, moveIncludes);
      if (btn && isVisible(btn, win) && !isDisabledish(btn)) break;
      await sleep(step);
    }

    if (!btn) {
      log.push({ ok: false, msg: "Move control not found (#st-moveForward missing — set Move button text hint)" });
      return { log, moved: false, skipped: false, amount: amount, inBudget: true };
    }
    if (isDisabledish(btn)) {
      log.push({ ok: false, msg: "Move forward looks disabled on this candidate — skipped" });
      return { log, moved: false, skipped: false, amount: amount, inBudget: true };
    }

    if (moveHost) {
      log.push({ ok: true, msg: "Clicking pipeline control #st-moveForward (visible target)" });
    }

    try {
      btn.scrollIntoView({ block: "center", behavior: "instant" });
    } catch (_) {}
    await sleep(80);
    try {
      btn.focus && btn.focus();
    } catch (_) {}
    await sleep(30);
    fireMoveForwardPipelineClick(win, btn, moveHost);
    log.push({ ok: true, msg: "Clicked Move forward (inner + spl host) — waiting for SR to apply" });
    await sleep(moveSettleMs);

    return { log, moved: true, skipped: false, amount: amount, inBudget: true };
  }

  async function runSalaryTriageMultiFrame(config) {
    const cfg = config || {};
    const frames = [window];
    try {
      const iframes = document.querySelectorAll("iframe");
      for (let i = 0; i < iframes.length; i++) {
        try {
          const w = iframes[i].contentWindow;
          if (w && w !== window) frames.push(w);
        } catch (_) {}
      }
    } catch (_) {}

    const tried = [];
    for (let j = 0; j < frames.length; j++) {
      const w = frames[j];
      let doc = null;
      try {
        doc = w.document;
      } catch (_) {
        continue;
      }
      if (!doc || !doc.documentElement) continue;

      const isTop = w === w.top;
      if (isTop && !isCandidateProfilePage(doc)) continue;
      if (!hasSrProfileChrome(doc)) {
        try {
          tried.push({ href: String(w.location && w.location.href).slice(0, 120), note: "no #st-moveForward / #st-screening" });
        } catch (_) {}
        continue;
      }

      return await runSalaryTriageWithDoc(doc, w, cfg, { subframeTriage: !isTop });
    }

    return {
      log: [
        {
          ok: false,
          msg: "No frame had both the profile URL (top window) and SR controls (#st-moveForward / #st-screening). Reload the extension if you use embedded frames.",
        },
        { ok: false, msg: "Frames checked: " + tried.length + "." },
      ],
      moved: false,
      skipped: true,
      amount: null,
      inBudget: null,
      frameProbe: tried.slice(0, 8),
    };
  }

  function elSnippet(el, maxLen) {
    if (!el) return "";
    try {
      return String(el.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLen || 80);
    } catch (_) {
      return "";
    }
  }

  function describeMoveState(doc, win) {
    const out = {
      moveHostFound: false,
      moveHostViaDeepWalk: false,
      moveHostTag: "",
      moveHostHasOpenShadow: false,
      moveTargetTag: "",
      moveTargetSnippet: "",
      moveTargetVisible: null,
      moveTargetDisabled: null,
      moveTargetRect: null,
      candidateButtons: [],
    };
    let host = null;
    try {
      host = doc.getElementById(MOVE_FORWARD_ID);
    } catch (_) {}
    if (!host) {
      try {
        host = findElementByIdDeep(doc.documentElement || doc.body, MOVE_FORWARD_ID);
        if (host) out.moveHostViaDeepWalk = true;
      } catch (_) {}
    }
    if (!host) return out;
    out.moveHostFound = true;
    out.moveHostTag = (host.tagName || "").toLowerCase();
    out.moveHostHasOpenShadow = !!host.shadowRoot;
    const target = resolveMoveForwardClickTarget(doc, win, host);
    if (target) {
      out.moveTargetTag = (target.tagName || "").toLowerCase();
      out.moveTargetSnippet = elSnippet(target, 100);
      out.moveTargetVisible = isVisible(target, win);
      out.moveTargetDisabled = isDisabledish(target);
      try {
        const r = target.getBoundingClientRect();
        out.moveTargetRect = { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) };
      } catch (_) {}
    }
    let cand = [];
    try {
      cand = queryDeepSelectorAll(host, win, 'button, [role="button"]');
    } catch (_) {}
    for (let i = 0; i < Math.min(cand.length, 8); i++) {
      const el = cand[i];
      out.candidateButtons.push({
        tag: (el.tagName || "").toLowerCase(),
        text: elSnippet(el, 70),
        visible: isVisible(el, win),
        disabled: isDisabledish(el),
      });
    }
    return out;
  }

  async function diagnoseSalaryTriage(config) {
    config = config || {};
    const doc = document;
    const win = window;
    const out = {
      frameHref: "",
      isTopWindow: false,
      isProfilePath: false,
      screeningIdLight: false,
      screeningIdDeep: false,
      openScreeningAttempted: false,
      screeningOpened: false,
      openSteps: [],
      screeningPairsCount: 0,
      pairsPreview: [],
      salaryQuestionPick: "",
      parsedAmount: null,
      budgetMin: null,
      budgetMax: null,
      inBudget: null,
      move: describeMoveState(doc, win),
    };
    try {
      out.frameHref = String(win.location.href || "");
    } catch (_) {}
    out.isTopWindow = win === win.top;
    out.isProfilePath = isCandidateProfilePage(doc);

    let sh = null;
    try {
      sh = doc.getElementById(SCREENING_TAB_ID);
    } catch (_) {}
    out.screeningIdLight = !!sh;
    if (!sh) {
      try {
        sh = findElementByIdDeep(doc.documentElement || doc.body, SCREENING_TAB_ID);
        out.screeningIdDeep = !!sh;
      } catch (_) {}
    }

    const hintsNorm = parseHints(config);
    const tmpLog = [];

    if (config.openScreening !== false) {
      out.openScreeningAttempted = true;
      out.screeningOpened = await clickScreeningTab(doc, win, tmpLog);
      out.openSteps = tmpLog.map(function (x) {
        return x.msg;
      });
      await sleep(Math.max(400, parseInt(config.screeningWaitMs, 10) || 900));
    }

    let pairs = [];
    try {
      pairs = getScreeningPairs(doc, win);
    } catch (e) {
      out.pairsPreview.push({ error: String((e && e.message) || e) });
      out.move = describeMoveState(doc, win);
      return out;
    }

    out.screeningPairsCount = pairs.length;
    for (let i = 0; i < Math.min(4, pairs.length); i++) {
      out.pairsPreview.push({ q: (pairs[i][0] || "").slice(0, 140), a: (pairs[i][1] || "").slice(0, 100) });
    }

    const picked = pickSalaryPair(pairs, hintsNorm);
    if (picked) {
      out.salaryQuestionPick = (picked[0] || "").slice(0, 160);
      out.parsedAmount = parseSalaryNumber(picked[1]);
    }
    const maxSalary = parseBudgetAmount(config.maxSalary);
    let minSalary = 0;
    if (config.minSalary != null && String(config.minSalary).trim() !== "") {
      const m = parseBudgetAmount(config.minSalary);
      if (isFinite(m)) minSalary = m;
    }
    out.budgetMax = isFinite(maxSalary) ? maxSalary : null;
    out.budgetMin = isFinite(minSalary) ? minSalary : null;
    if (out.budgetMax != null && out.budgetMax > 0 && out.parsedAmount != null && isFinite(out.parsedAmount)) {
      out.inBudget = out.parsedAmount >= minSalary && out.parsedAmount <= maxSalary;
    }

    out.move = describeMoveState(doc, win);
    return out;
  }

  async function runSalaryTriage(config) {
    return runSalaryTriageWithDoc(document, window, config || {}, {});
  }

  function normalizeProfilePath(href) {
    try {
      const u = new URL(href, location.origin);
      const m = u.pathname.match(/^(\/app\/people\/(?:applications|profile)\/[^/]+)\/?/i);
      return m ? u.origin + m[1] + "/" : "";
    } catch (_) {
      return "";
    }
  }

  function hrefFromNode(el) {
    if (!el) return "";
    try {
      const a = el.getAttribute && el.getAttribute("href");
      if (a) return a;
      if (el.href) return String(el.href);
    } catch (_) {}
    return "";
  }

  /**
   * Applicants table: profile opens via the name (`spl-truncate[data-test="applicant-name"]`), often a
   * parent <a> / <sr-link> or a link elsewhere in the row — not always `a[href^="/app/people/..."]` alone.
   */
  function harvestProfileUrls(doc, win) {
    const seen = new Set();
    const urls = [];

    function addRaw(raw) {
      const path = normalizeProfilePath(raw);
      if (!path || seen.has(path)) return;
      seen.add(path);
      urls.push(path);
    }

    const broadSel =
      'a[href*="/app/people/applications/"], a[href*="/app/people/profile/"], sr-link[href*="/app/people/applications/"], sr-link[href*="/app/people/profile/"]';

    function harvestSelectorList(root, useDeep) {
      let list = [];
      if (useDeep) {
        list = queryDeepSelectorAll(root, win, broadSel);
      } else {
        try {
          list = Array.from(root.querySelectorAll(broadSel));
        } catch (_) {
          list = [];
        }
      }
      for (let i = 0; i < list.length; i++) {
        addRaw(hrefFromNode(list[i]));
      }
    }

    const root = doc.body || doc.documentElement;
    harvestSelectorList(root, false);
    harvestSelectorList(root, true);

    try {
      doc
        .querySelectorAll(
          "#st-jobDetailsPage spl-table a[href*='/app/people/'], " +
            "#st-jobDetailsPage spl-table sr-link[href*='/app/people/'], " +
            "#st-jobDetailsPage app-applicant-list-container a[href*='/app/people/'], " +
            "#st-jobDetailsPage app-applicant-list-container sr-link[href*='/app/people/'], " +
            "#st-jobDetailsPage app-people-tab-applicant-list-container a[href*='/app/people/'], " +
            "#st-jobDetailsPage people-tab-container a[href*='/app/people/']"
        )
        .forEach(function (n) {
          addRaw(hrefFromNode(n));
        });
    } catch (_) {}

    const nameHosts = new Set();
    try {
      doc.querySelectorAll('[data-test="applicant-name"], spl-truncate.applicant-name--name-truncate').forEach(function (n) {
        nameHosts.add(n);
      });
    } catch (_) {}
    try {
      queryDeepSelectorAll(root, win, '[data-test="applicant-name"]').forEach(function (n) {
        nameHosts.add(n);
      });
    } catch (_) {}

    nameHosts.forEach(function (host) {
      let el = host;
      for (let up = 0; up < 24 && el; up++) {
        const tag = (el.tagName || "").toUpperCase();
        if (tag === "A" || tag === "SR-LINK") {
          addRaw(hrefFromNode(el));
          break;
        }
        try {
          const inner = el.querySelector && el.querySelector(broadSel);
          if (inner) {
            addRaw(hrefFromNode(inner));
            break;
          }
        } catch (_) {}
        el = el.parentElement;
      }

      let row = null;
      try {
        row = host.closest && host.closest("tr");
      } catch (_) {}
      if (!row) {
        try {
          row = host.closest && host.closest('[role="row"]');
        } catch (_) {}
      }
      if (row) {
        try {
          row.querySelectorAll(broadSel).forEach(function (n) {
            addRaw(hrefFromNode(n));
          });
        } catch (_) {}
      }
    });

    return urls;
  }

  function resolveApplicantClickTarget(host) {
    if (!host) return null;
    try {
      const inJobList = host.closest && host.closest("#st-jobDetailsPage");
      if (inJobList) {
        const directA = host.closest && host.closest("a[href*='/app/people/']");
        if (directA) return directA;
      }
    } catch (_) {}
    try {
      const cell = host.closest && (host.closest("td") || host.closest('[role="gridcell"]'));
      if (cell) {
        const a = cell.querySelector(
          'a[href*="/app/people/"], sr-link[href*="/app/people/"], a[href^="/app/people/"]'
        );
        if (a) return a;
      }
    } catch (_) {}
    let el = host;
    for (let up = 0; up < 32 && el; up++) {
      const tag = (el.tagName || "").toUpperCase();
      if (tag === "A" || tag === "SR-LINK") return el;
      const role = String((el.getAttribute && el.getAttribute("role")) || "").toLowerCase();
      if (role === "link" || role === "button") return el;
      el = el.parentElement;
    }
    return host;
  }

  function collectApplicantClickTargets(doc, win) {
    const out = [];
    const seenClickEl = new Set();
    const seenRow = new WeakSet();
    const seenHost = new Set();

    function rowKeyForSplTable(host) {
      let el = host;
      for (let i = 0; i < 28 && el; i++) {
        const p = el.parentElement;
        if (!p) break;
        const tag = (p.tagName || "").toLowerCase();
        if (tag === "spl-table") return el;
        el = p;
      }
      return null;
    }

    function markRowAndPush(el, rowHint) {
      if (!el || seenClickEl.has(el)) return;
      if (rowHint) {
        if (seenRow.has(rowHint)) return;
        seenRow.add(rowHint);
      }
      seenClickEl.add(el);
      out.push(el);
    }

    try {
      doc
        .querySelectorAll(
          "#st-jobDetailsPage spl-table a[href*='/app/people/applications/'], " +
            "#st-jobDetailsPage spl-table a[href*='/app/people/profile/'], " +
            "#st-jobDetailsPage spl-table sr-link[href*='/app/people/'], " +
            "#st-jobDetailsPage app-applicant-list-container a[href*='/app/people/'], " +
            "#st-jobDetailsPage app-applicant-list-container sr-link[href*='/app/people/'], " +
            "#st-jobDetailsPage app-people-tab-applicant-list-container a[href*='/app/people/'], " +
            "#st-jobDetailsPage app-people-tab-applicant-list-container sr-link[href*='/app/people/'], " +
            "#st-jobDetailsPage people-tab-container a[href*='/app/people/'], " +
            "#st-jobDetailsPage people-tab-container sr-link[href*='/app/people/']"
        )
        .forEach(function (linkEl) {
          const underTable = linkEl.closest && linkEl.closest("spl-table");
          const rowHint =
            underTable && linkEl.parentElement
              ? linkEl.parentElement
              : linkEl.closest("tr") || linkEl.closest('[role="row"]');
          markRowAndPush(linkEl, rowHint || linkEl);
        });
    } catch (_) {}

    function considerHost(host) {
      if (!host || seenHost.has(host)) return;
      seenHost.add(host);
      let row = null;
      try {
        row = host.closest && (host.closest("tr") || host.closest('[role="row"]'));
      } catch (_) {}
      if (!row) {
        try {
          row = rowKeyForSplTable(host);
        } catch (_) {}
      }
      if (row) {
        if (seenRow.has(row)) return;
        seenRow.add(row);
      }
      const target = resolveApplicantClickTarget(host);
      if (!target || seenClickEl.has(target)) return;
      seenClickEl.add(target);
      out.push(target);
    }

    const root = doc.body || doc.documentElement;
    try {
      doc.querySelectorAll('[data-test="applicant-name"], spl-truncate.applicant-name--name-truncate').forEach(considerHost);
    } catch (_) {}
    try {
      queryDeepSelectorAll(root, win, '[data-test="applicant-name"]').forEach(considerHost);
    } catch (_) {}

    try {
      doc
        .querySelectorAll(
          "#st-jobDetailsPage app-applicant-list-container spl-typography-title spl-truncate, " +
            "#st-jobDetailsPage app-people-tab-applicant-list-container spl-typography-title spl-truncate, " +
            "#st-jobDetailsPage people-tab-container spl-typography-title spl-truncate, " +
            "#st-jobDetailsPage spl-table spl-typography-title spl-truncate"
        )
        .forEach(considerHost);
    } catch (_) {}

    return out;
  }

  function fireClick(win, el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: "center", behavior: "instant" });
    } catch (_) {}
    try {
      el.click();
    } catch (_) {
      try {
        const r = el.getBoundingClientRect();
        const x = r.left + Math.min(r.width / 2, 80);
        const y = r.top + Math.min(r.height / 2, 20);
        el.dispatchEvent(
          new win.MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: win })
        );
      } catch (_) {}
    }
  }

  function startQueueFromPage(config) {
    const doc = document;
    const win = window;
    const log = [];
    const KEY = "sr_ext_salary_triage_v1";
    const waitMs = Math.max(200, parseInt(config.screeningWaitMs, 10) || 600);
    const moveSettleMs = Math.max(300, parseInt(config.moveSettleMs, 10) || 700);
    const afterMoveNavigateMs = Math.max(300, parseInt(config.afterMoveNavigateMs, 10) || 600);
    const moveButtonReadyMs = Math.max(500, parseInt(config.moveButtonReadyMs, 10) || 2500);
    const queueReadyMaxMs = Math.max(2000, parseInt(config.queueReadyMaxMs, 10) || 10000);
    const baseState = {
      returnUrl: win.location.href,
      initialDelayMs: Math.max(400, waitMs),
      config: {
        maxSalary: config.maxSalary,
        minSalary: config.minSalary,
        questionHints: config.questionHints,
        moveButtonIncludes: config.moveButtonIncludes,
        dryRun: config.dryRun,
        screeningWaitMs: waitMs,
        moveSettleMs: moveSettleMs,
        afterMoveNavigateMs: afterMoveNavigateMs,
        moveButtonReadyMs: moveButtonReadyMs,
        queueReadyMaxMs: queueReadyMaxMs,
      },
      log: [],
      results: [],
      startedAt: Date.now(),
    };

    const urls = harvestProfileUrls(doc, win);
    if (urls.length) {
      const state = Object.assign({}, baseState, {
        kind: "urls",
        queue: urls.slice(),
      });
      try {
        sessionStorage.setItem(KEY, JSON.stringify(state));
      } catch (e) {
        log.push({ ok: false, msg: "sessionStorage failed: " + (e && e.message) });
        return { ok: false, log, queued: 0 };
      }
      log.push({ ok: true, msg: "Queued " + urls.length + " profiles (URL list)" });
      win.location.replace(state.queue[0]);
      return { ok: true, log, queued: urls.length, mode: "urls" };
    }

    const targets = collectApplicantClickTargets(doc, win);
    if (!targets.length) {
      log.push({
        ok: false,
        msg:
          "No applicant rows found — open **Applicants**, scroll to load names, then queue again. (Click mode uses [data-test=\"applicant-name\"].)",
      });
      return { ok: false, log, queued: 0 };
    }

    const state = Object.assign({}, baseState, {
      kind: "click",
      clickIndex: 0,
      total: targets.length,
    });
    try {
      sessionStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      log.push({ ok: false, msg: "sessionStorage failed: " + (e && e.message) });
      return { ok: false, log, queued: 0 };
    }
    log.push({
      ok: true,
      msg: "Queued " + targets.length + " applicants (click names — same tab)",
    });
    fireClick(win, targets[0]);
    return { ok: true, log, queued: targets.length, mode: "click" };
  }

  globalThis.__srSalaryTriageRun = function (config) {
    return runSalaryTriage(config || {});
  };
  globalThis.__srSalaryTriageRunMulti = function (config) {
    return runSalaryTriageMultiFrame(config || {});
  };
  globalThis.__srSalaryTriageRunOrSkip = function (c) {
    const doc = document;
    const win = window;
    let href = "";
    try {
      href = String(win.location.href || "");
    } catch (_) {}
    const cfg = c || {};
    return (async function () {
      if (!hasSrProfileChrome(doc)) {
        return { skippedWrongFrame: true, frameHref: href, reason: "no_st_moveForward_or_st_screening" };
      }
      const isTop = win === win.top;
      if (isTop && !isCandidateProfilePage(doc)) {
        return { skippedWrongFrame: true, frameHref: href, reason: "top_frame_not_candidate_profile_url" };
      }
      return await runSalaryTriageWithDoc(doc, win, cfg, { subframeTriage: !isTop });
    })();
  };
  globalThis.__srSalaryTriageDiagnose = function (config) {
    return diagnoseSalaryTriage(config || {});
  };
  globalThis.__srSalaryTriageStartQueue = function (config) {
    return startQueueFromPage(config || {});
  };
  globalThis.__srCollectApplicantClickTargets = function () {
    return collectApplicantClickTargets(document, window);
  };
})();
