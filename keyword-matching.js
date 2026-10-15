// @ts-check
// keyword-matching.js — keyword search: keyword normalization, matching and the boolean query parser (no DOM).
// One of the keyword-*.js modules that keyword-triage-core.js runs. They share the
// globalThis.__srKw namespace (require() under Node) and load in dependency order:
// dom → matching → extract → pipeline → notes → diag → core.

(function () {
  "use strict";

  // KEYWORD_EXPANSIONS, KEYWORD_TYPO_ALIASES, and resolver functions are loaded from
  // keyword-expansions.js (runs as a content script before this file).

  /** @typedef {{ keyword: string, count: number }} KeywordHit */
  /**
   * Token counts of a normalised haystack; bigram/trigram keys join tokens with "\x00".
   * @typedef {{ uni: Record<string, number>, bi: Record<string, number>, tri: Record<string, number> }} TokenIndex
   */
  /**
   * @typedef {{ type: "PHRASE" | "TERM", value: string }
   *   | { type: "LPAREN" | "RPAREN" | "AND" | "OR" | "NOT" }} BoolToken
   */
  /**
   * @typedef {{ type: "TERM", value: string, quoted?: boolean }
   *   | { type: "NOT", operand: BoolAst }
   *   | { type: "AND" | "OR", left: BoolAst, right: BoolAst }} BoolAst
   */

  /**
   * Synonym forms for one boolean leaf (same table as comma keywords, plus typo table).
   * @param {string} term
   * @returns {string[]}
   */
  function expandOneBooleanTerm(term) {
    var t = (term || "").trim();
    if (!t) return [];
    var low = t.toLowerCase();
    if (KEYWORD_TYPO_ALIASES[low]) t = KEYWORD_TYPO_ALIASES[low];
    var table = buildExpansionTable();
    /** @type {string[]} */
    var out = [];
    /** @type {Record<string, boolean>} */
    var seen = {};
    /** @param {string} s */
    function push(s) {
      var x = (s || "").trim();
      if (!x) return;
      var k = x.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push(x);
    }
    push(t);
    var forms = table[t.toLowerCase()];
    if (forms) {
      for (var i = 0; i < forms.length; i++) push(forms[i]);
    }
    return out;
  }

  /* ── Text normalization (ported from req.py _normalize_for_kw) ── */

  /**
   * @param {unknown} s
   * @returns {string}
   */
  function normalizeForKw(s) {
    if (!s) return "";
    var str = String(s);
    try {
      if (typeof str.normalize === "function") str = str.normalize("NFKC");
    } catch (_) {}
    str = str.replace(/[\u200B-\u200D\uFEFF]/g, "");
    str = str.replace(/\u00AD/g, "");
    str = str.replace(/\u2060/g, "");
    str = str.replace(/\u00A0/g, " ").replace(/\u202F/g, " ").replace(/\u2007/g, " ");
    str = str.replace(/\u00B7/g, " ").replace(/\u2022/g, " ");
    str = str.replace(/\s+/g, " ");
    return str.trim();
  }

  /**
   * Collapse exact-duplicate text segments before keyword counting.
   *
   * SR assembles candidate text from many overlapping sources: the resume, a
   * full-page shadow-DOM scan that re-captures that same resume, and
   * getProfileOverviewText's selector list (`[class*="profile"]`, `*="skills"`,
   * `*="summary"`, `*="education"` …) which matches nested and repeated elements.
   * The identical chunk can therefore land in allText 5-10×, inflating occurrence
   * counts (e.g. "phd (x65)" when the resume says PhD six times).
   *
   * Splitting on newlines and dropping repeat segments removes that duplication.
   * Every distinct segment is kept once, so keyword *presence* — and thus the
   * Matched X/Y hit/miss result — is unchanged; only the displayed counts shrink
   * to their true values. Short segments (< 12 chars) are kept verbatim so unique
   * one-word data is never lost.
   * @template {string | null | undefined} T
   * @param {T} text
   * @returns {T}
   */
  function dedupeTextSegments(text) {
    if (!text) return text;
    var segs = String(text).split(/\n+/);
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var key = segs[i].replace(/\s+/g, " ").trim().toLowerCase();
      if (!key) continue;
      if (key.length >= 12) {
        if (seen[key]) continue;
        seen[key] = true;
      }
      out.push(segs[i]);
    }
    return /** @type {T} */ (out.join("\n"));
  }

  /**
   * Collapse phrase runs that are immediately repeated within a single line.
   *
   * dedupeTextSegments only folds duplication that sits on its own newline. But
   * SR renders most resumes through pdf.js, whose text layer (and many
   * graphically-designed CV templates) emit the same visual text 2-3× as
   * overlapping spans. getPdfTextLayerText space-joins those spans into one
   * newline-free blob, so a single "Azure" mention is tokenised 3-4× and counted
   * as "azure (x20)" — even though a recruiter reading the page sees it ~5×.
   *
   * This collapses runs the way a human reads the page once: it removes only a
   * run that is IMMEDIATELY repeated, so genuine repeats in different sentences
   * survive and counts stay truthful. The comparison runs on a lowercased,
   * separator-free character stream, so the spacing variants pdf.js emits
   * ("AI Fundamentals" vs "AIFundamentals") collapse to the same unit. Survivors
   * keep their original casing and punctuation, so downstream camelCase
   * splitting and phrase matching are unchanged.
   * @template {string | null | undefined} T
   * @param {T} text
   * @returns {T}
   */
  function collapseInlineRepeats(text) {
    if (!text) return text;
    var s = String(text);
    var re = /[A-Za-z0-9]+/g, m;
    /** @type {{ s: number, e: number }[]} */
    var toks = [];
    while ((m = re.exec(s)) !== null) {
      toks.push({ s: m.index, e: re.lastIndex });
      if (toks.length > 80000) return text; // pathological input — bail, unchanged
    }
    var n = toks.length;
    if (n < 4) return text;

    // Separator-free lowercased char stream + each token's start offset in it.
    var C = "", coff = new Array(n);
    for (var i = 0; i < n; i++) {
      coff[i] = C.length;
      C += s.slice(toks[i].s, toks[i].e).toLowerCase();
    }
    var Clen = C.length;
    var MAXM = 200; // longest repeated unit (in chars) we will collapse

    /** @param {number} a @param {number} b @param {number} len */
    function eqAt(a, b, len) {
      for (var k = 0; k < len; k++) {
        if (C.charCodeAt(a + k) !== C.charCodeAt(b + k)) return false;
      }
      return true;
    }

    var keep = new Array(n);
    for (var k0 = 0; k0 < n; k0++) keep[k0] = true;

    var t = 0;
    while (t < n) {
      var p = coff[t];
      // Largest unit [t, bestEnd) whose chars are immediately repeated next.
      var bestEnd = -1, bestM = 0;
      for (var e = t + 1; e < n; e++) {
        var mlen = coff[e] - p;
        if (mlen > MAXM) break;
        if (p + 2 * mlen > Clen) break;
        if (eqAt(p, p + mlen, mlen)) { bestEnd = e; bestM = mlen; }
      }
      if (bestEnd > t) {
        // Keep the first copy [t, bestEnd); drop every immediately-repeated copy.
        var nextStart = p + bestM;
        var j = bestEnd;
        while (nextStart + bestM <= Clen && eqAt(p, nextStart, bestM)) {
          while (j < n && coff[j] < nextStart + bestM) { keep[j] = false; j++; }
          nextStart += bestM;
        }
        t = j; // resume after the dropped copies
      } else {
        t++;
      }
    }

    // Rebuild: emit survivors with their original text; replace each dropped
    // token (and the separator before it) with a single space.
    var out = "", cursor = 0;
    for (var x = 0; x < n; x++) {
      if (keep[x]) {
        out += s.slice(cursor, toks[x].e);
        cursor = toks[x].e;
      } else {
        out += " ";
        cursor = toks[x].e;
      }
    }
    out += s.slice(cursor);
    return /** @type {T} */ (out);
  }

  /* ── Keyword matching (ported from req.py find_keyword_hits) ── */

  /**
   * Regex source matching `kwNorm` with any separators between its tokens.
   * @param {string} kwNorm
   * @param {boolean} withSuffix - also allow s/es/ed/ing after the last token
   * @returns {string} "" when the keyword has no letters or digits
   */
  function sepFlexiblePatternSource(kwNorm, withSuffix) {
    var tokens = kwNorm.match(/[A-Za-z]+|\d+/g);
    if (!tokens || !tokens.length) return "";
    var mid = "[\\W_]*";
    var body = tokens
      .map(function (t) {
        return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join(mid);
    if (!body) return "";
    var trailingBoundary = withSuffix
      ? "(?:e?s|ed|ing)?(?![A-Za-z0-9])"
      : "(?![A-Za-z0-9])";
    return "(?<![A-Za-z0-9])" + body + trailingBoundary;
  }

  /** ISO list heuristic: "ISO Standard (9001, 45001)" matches keyword "ISO 45001".
   *  Uses a proximity window because normalizeForKw strips newlines from hay.
   * @param {string} hay
   * @param {string} num
   */
  function isoListHit(hay, num) {
    if (!num) return false;
    var numStr = String(num);
    var numRxSrc;
    try {
      var esc = numStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      numRxSrc = "(?<!\\d)" + esc + "(?!\\d)";
    } catch (_) {
      return false;
    }
    var isoRx = /\bISO\b/gi;
    var numRx;
    try { numRx = new RegExp(numRxSrc, "i"); } catch (_) { return false; }
    var WINDOW = 200;
    var m;
    while ((m = isoRx.exec(hay)) !== null) {
      var start = Math.max(0, m.index - 20);
      var end = Math.min(hay.length, m.index + WINDOW);
      if (numRx.test(hay.slice(start, end))) return true;
    }
    return false;
  }

  /**
   * Build unigram / bigram / trigram count maps from normalised haystack text.
   *
   * CamelCase tokens are split before indexing so expansion forms like "tensor flow"
   * and "py torch" match resume text written as "TensorFlow" / "PyTorch":
   *   "TensorFlow" → ["tensor","flow"]   "PyTorch" → ["py","torch"]
   *
   * Tokens are lowercased and split on every non-alphanumeric character, so
   * "tf.keras" → ["tf","keras"], "ci/cd" → ["ci","cd"], "k8s" → ["k8s"].
   * @param {string} hay
   * @returns {TokenIndex}
   */
  function buildTokenIndex(hay) {
    var split = hay
      .replace(/([a-z\d])([A-Z])/g,        "$1 $2")   // fooBar  → foo Bar
      .replace(/([A-Z]{2,})([A-Z][a-z])/g, "$1 $2");  // ABCDef  → ABC Def

    var rawParts = split.toLowerCase().split(/[^a-z0-9]+/);
    var tokens = [];
    for (var ti = 0; ti < rawParts.length; ti++) {
      if (rawParts[ti]) tokens.push(rawParts[ti]);
    }

    var uni = Object.create(null);  // token            → count
    var bi  = Object.create(null);  // "t1\x00t2"       → count
    var tri = Object.create(null);  // "t1\x00t2\x00t3" → count

    for (var i = 0; i < tokens.length; i++) {
      var a = tokens[i];
      uni[a] = (uni[a] || 0) + 1;
      if (i + 1 < tokens.length) {
        var b = tokens[i + 1];
        var kb = a + "\x00" + b;
        bi[kb] = (bi[kb] || 0) + 1;
        if (i + 2 < tokens.length) {
          var c = tokens[i + 2];
          tri[kb + "\x00" + c] = (tri[kb + "\x00" + c] || 0) + 1;
        }
      }
    }
    return { uni: uni, bi: bi, tri: tri };
  }

  // Suffix variants mirror the (?:e?s|ed|ing)? suffix in sepFlexiblePatternSource
  // so "publications" matches keyword "publication", "researching" matches "research", etc.
  var _KW_SFX = ["", "s", "es", "ed", "ing"];

  /**
   * Look up a normalised keyword in the token index.
   * Returns hit count (≥1), 0 (not found), or -1 (needs regex — 4+ token phrase
   * or multi-token wildcard the index can't resolve directly).
   * @param {string} kwNorm
   * @param {TokenIndex} idx
   * @param {boolean} isWildcard
   * @returns {number}
   */
  function kwHitsInIndex(kwNorm, idx, isWildcard) {
    var toks = kwNorm.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!toks.length) return 0;

    // Wildcard: iterate unigrams for any token that starts with the prefix.
    if (isWildcard) {
      if (toks.length !== 1) return -1; // multi-token wildcard → regex
      var pref = toks[0];
      var wTotal = 0;
      for (var wt in idx.uni) {
        if (wt.length >= pref.length && wt.substring(0, pref.length) === pref) {
          wTotal += idx.uni[wt];
        }
      }
      return wTotal;
    }

    if (toks.length === 1) {
      var stem = toks[0];
      var uTotal = 0;
      for (var si = 0; si < _KW_SFX.length; si++) {
        uTotal += idx.uni[stem + _KW_SFX[si]] || 0;
      }
      return uTotal;
    }

    if (toks.length === 2) {
      var base2 = toks[0] + "\x00" + toks[1];
      if (idx.bi[base2]) return idx.bi[base2];
      for (var si2 = 1; si2 < _KW_SFX.length; si2++) {
        var k2 = toks[0] + "\x00" + toks[1] + _KW_SFX[si2];
        if (idx.bi[k2]) return idx.bi[k2];
      }
      return 0;
    }

    if (toks.length === 3) {
      var base3 = toks[0] + "\x00" + toks[1] + "\x00" + toks[2];
      if (idx.tri[base3]) return idx.tri[base3];
      for (var si3 = 1; si3 < _KW_SFX.length; si3++) {
        var k3 = toks[0] + "\x00" + toks[1] + "\x00" + toks[2] + _KW_SFX[si3];
        if (idx.tri[k3]) return idx.tri[k3];
      }
      return 0;
    }

    return -1; // 4+ token phrase → regex fallback
  }

  /**
   * @param {string|string[]} texts - haystack(s); joined with space then normalised
   * @param {string[]} keywords
   * @param {{ maxItems?: number, scanEveryKeyword?: boolean }} [opts]
   * @returns {{ hits: KeywordHit[], hitCount: number }}
   */
  function findKeywordHits(texts, keywords, opts) {
    opts = opts || {};
    var rawCap = parseInt(String(opts.maxItems), 10);
    var maxItems = Number.isFinite(rawCap) && rawCap > 0 ? Math.min(15000, rawCap) : 50;
    var scanEveryKeyword = !!(opts && opts.scanEveryKeyword);
    var joined =
      typeof texts === "string"
        ? texts
        : Array.isArray(texts)
          ? texts.filter(Boolean).join(" ")
          : "";
    var hay = normalizeForKw(joined);
    if (!hay) return { hits: [], hitCount: 0 };

    // Build token index once — all keyword lookups in this call share it.
    var idx = buildTokenIndex(hay);

    /** @type {KeywordHit[]} */
    var found = [];
    /** @type {Record<string, boolean>} */
    var seenLower = {};

    for (var i = 0; i < keywords.length; i++) {
      if (!scanEveryKeyword && found.length >= maxItems) break;
      var kwDisp = (keywords[i] || "").trim();
      if (!kwDisp) continue;
      var kwKey = kwDisp;
      if (kwKey.charAt(0) === "(" && kwKey.charAt(kwKey.length - 1) === ")") {
        var inner2 = kwKey.slice(1, -1).trim();
        if (inner2) kwKey = inner2;
      }
      var kwNorm = normalizeForKw(kwKey);
      if (!kwNorm) continue;

      // Trailing * = prefix wildcard (LinkedIn-style)
      var isWildcard = kwNorm.charAt(kwNorm.length - 1) === "*";
      if (isWildcard) {
        kwNorm = kwNorm.slice(0, -1).replace(/\s+$/, "");
        if (!kwNorm) continue;
      }

      var count = 0;
      var idxResult = kwHitsInIndex(kwNorm, idx, isWildcard);

      if (idxResult > 0) {
        count = idxResult;
      } else if (idxResult === -1 || idxResult === 0) {
        // -1: 4+ token phrase or multi-token wildcard.
        // 0: 1–3 token keyword not found in token index — try separator-flexible
        //    regex to catch compound forms like "gpt4" matching "GPT-4".
        var src = sepFlexiblePatternSource(kwNorm, !isWildcard);
        if (isWildcard && src) {
          var tail = "(?![A-Za-z0-9])";
          var tailIdx = src.lastIndexOf(tail);
          if (tailIdx >= 0) src = src.slice(0, tailIdx) + "[A-Za-z0-9]*";
        }
        if (src) {
          try {
            var rx = new RegExp(src, "gi");
            var m = hay.match(rx);
            count = m ? m.length : 0;
          } catch (_) {
            count = 0;
          }
        }
      }

      // ISO list heuristic: "ISO Standard 9001, 45001" — number not adjacent to ISO token.
      if (count === 0) {
        var toks = kwNorm.match(/[A-Za-z]+|\d+/g);
        if (toks && toks.length && toks[0].toLowerCase() === "iso") {
          var num = "";
          for (var t = 1; t < toks.length; t++) {
            if (/^\d+$/.test(toks[t])) { num = toks[t]; break; }
          }
          if (num && isoListHit(hay, num)) count = 1;
        }
      }

      if (count > 0) {
        var keyL = kwDisp.toLowerCase();
        if (!seenLower[keyL]) {
          seenLower[keyL] = true;
          found.push({ keyword: kwDisp, count: count });
        }
      }
    }
    return { hits: found, hitCount: found.length };
  }

  /**
   * Collapse expansion aliases back to the canonical (user-typed) keyword.
   *
   * When resolveKeywordsWithMeta expands "pytorch" into "py torch", "torch", etc.,
   * all those aliases may match the same occurrences in the text. This function
   * folds them into one entry under the canonical name, taking the MAX count
   * across the group so the count reflects the strongest signal.
   *
   * If a form has no entry in canonicalMap it is treated as its own canonical.
   * Pass null/undefined canonicalMap to skip deduplication (no-op passthrough).
   * @param {KeywordHit[]} hits
   * @param {Record<string, string> | null | undefined} canonicalMap - lowercased form → canonical keyword
   * @returns {KeywordHit[]}
   */
  function deduplicateHitsByCanonical(hits, canonicalMap) {
    if (!canonicalMap) return hits;
    /** @type {Record<string, KeywordHit>} */
    var groups = Object.create(null);
    /** @type {string[]} */
    var order = [];
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      var canon = canonicalMap[h.keyword.toLowerCase()] || h.keyword;
      var cl = canon.toLowerCase();
      if (!groups[cl]) {
        groups[cl] = { keyword: canon, count: 0 };
        order.push(cl);
      }
      if (h.count > groups[cl].count) groups[cl].count = h.count;
    }
    return order.map(function (cl) { return groups[cl]; });
  }

  /**
   * Per-canonical occurrence counts computed from the RESUME text alone.
   *
   * Displayed counts ("phd (x25)") get inflated when an expansion alias such as
   * "doctorate" matches SR's repeated profile/skill chrome. Counting against the
   * resume only — which never contains that chrome — yields the true number of
   * times the candidate's resume mentions the keyword.
   *
   * Returns a map { canonicalLower: count }, or null when there is no real resume
   * (sparse, or SR summary chrome) so the caller falls back to the union count.
   * @param {string | null | undefined} resumeText
   * @param {string[]} keywords
   * @param {Record<string, string> | null | undefined} canonicalMap
   * @returns {Record<string, number> | null}
   */
  function countsFromResume(resumeText, keywords, canonicalMap) {
    if (!resumeText || resumeText.length < 300) return null;
    if (looksLikeSrSummaryChrome(resumeText)) return null;
    var clean = normalizeForKw(collapseInlineRepeats(dedupeTextSegments(resumeText)));
    if (!clean) return null;
    var hits = findKeywordHits(clean, keywords).hits;
    var deduped = deduplicateHitsByCanonical(hits, canonicalMap);
    /** @type {Record<string, number>} */
    var map = Object.create(null);
    for (var i = 0; i < deduped.length; i++) map[deduped[i].keyword.toLowerCase()] = deduped[i].count;
    return map;
  }

  /* ── Boolean search parser (LinkedIn Recruiter–style syntax) ── */

  /**
   * @param {unknown} input
   * @returns {BoolToken[]}
   */
  function tokenizeBoolean(input) {
    /** @type {BoolToken[]} */
    var tokens = [];
    var i = 0;
    var s = String(input || "");
    while (i < s.length) {
      if (/\s/.test(s[i])) {
        i++;
        continue;
      }
      if (s[i] === '"' || s[i] === "\u201C" || s[i] === "\u201D") {
        var closeChars = ['"', "\u201C", "\u201D"];
        i++;
        var start = i;
        while (i < s.length && closeChars.indexOf(s[i]) < 0) i++;
        var phrase = s.slice(start, i).trim();
        if (i < s.length) i++;
        if (phrase) tokens.push({ type: "PHRASE", value: phrase });
        continue;
      }
      if (s[i] === "(") {
        tokens.push({ type: "LPAREN" });
        i++;
        continue;
      }
      if (s[i] === ")") {
        tokens.push({ type: "RPAREN" });
        i++;
        continue;
      }
      var wStart = i;
      while (i < s.length && !/\s/.test(s[i]) && s[i] !== "(" && s[i] !== ")" && s[i] !== '"' && s[i] !== "\u201C" && s[i] !== "\u201D")
        i++;
      var word = s.slice(wStart, i);
      if (!word) continue;
      var upper = word.toUpperCase();
      if (upper === "AND") tokens.push({ type: "AND" });
      else if (upper === "OR") tokens.push({ type: "OR" });
      else if (upper === "NOT") tokens.push({ type: "NOT" });
      else tokens.push({ type: "TERM", value: word });
    }
    return tokens;
  }

  /**
   * LinkedIn Recruiter-style query → AST. Precedence NOT > AND > OR; adjacent terms AND.
   * @param {unknown} input
   * @returns {BoolAst}
   */
  function parseBooleanQuery(input) {
    var tokens = tokenizeBoolean(input);
    var pos = 0;

    /** @returns {BoolToken | null} */
    function peek() {
      return pos < tokens.length ? tokens[pos] : null;
    }
    /** @param {BoolToken["type"]} type */
    function peekIs(type) {
      var t = peek();
      return !!t && t.type === type;
    }
    function consume() {
      return tokens[pos++];
    }

    /** @returns {BoolAst} */
    function parseOr() {
      /** @type {BoolAst} */
      var left = parseAnd();
      while (peekIs("OR")) {
        consume();
        var right = parseAnd();
        left = { type: "OR", left: left, right: right };
      }
      return left;
    }

    /** @returns {BoolAst} */
    function parseAnd() {
      /** @type {BoolAst} */
      var left = parseNot();
      var t;
      while ((t = peek())) {
        if (t.type === "AND") {
          consume();
          var right = parseNot();
          left = { type: "AND", left: left, right: right };
        } else if (t.type === "TERM" || t.type === "PHRASE" || t.type === "LPAREN" || t.type === "NOT") {
          var right2 = parseNot();
          left = { type: "AND", left: left, right: right2 };
        } else {
          break;
        }
      }
      return left;
    }

    /** @returns {BoolAst} */
    function parseNot() {
      if (peekIs("NOT")) {
        consume();
        var operand = parseAtom();
        return { type: "NOT", operand: operand };
      }
      return parseAtom();
    }

    /** @returns {BoolAst} */
    function parseAtom() {
      var t = peek();
      if (!t) return { type: "TERM", value: "" };

      if (t.type === "LPAREN") {
        consume();
        var expr = parseOr();
        if (peekIs("RPAREN")) consume();
        return expr;
      }

      if (t.type === "PHRASE") {
        consume();
        return { type: "TERM", value: t.value, quoted: true };
      }

      if (t.type === "TERM") {
        consume();
        return { type: "TERM", value: t.value };
      }

      consume();
      return { type: "TERM", value: "" };
    }

    if (!tokens.length) return { type: "TERM", value: "" };
    return parseOr();
  }

  /**
   * @param {BoolAst | null | undefined} ast
   * @param {boolean} [negated]
   * @returns {{ value: string, negated: boolean }[]}
   */
  function extractLeafTerms(ast, negated) {
    negated = !!negated;
    if (!ast) return [];
    if (ast.type === "TERM") {
      if (!ast.value) return [];
      return [{ value: ast.value, negated: negated }];
    }
    if (ast.type === "NOT") {
      return extractLeafTerms(ast.operand, true);
    }
    if (ast.type === "AND" || ast.type === "OR") {
      return extractLeafTerms(ast.left, negated).concat(extractLeafTerms(ast.right, negated));
    }
    return [];
  }

  /**
   * @param {BoolAst | null | undefined} ast
   * @param {Record<string, unknown>} matchedSet - lowercased term → truthy when matched
   * @returns {boolean}
   */
  function evaluateBooleanAst(ast, matchedSet) {
    if (!ast) return false;
    if (ast.type === "TERM") {
      var key = (ast.value || "").toLowerCase();
      return !!matchedSet[key];
    }
    if (ast.type === "NOT") {
      return !evaluateBooleanAst(ast.operand, matchedSet);
    }
    if (ast.type === "AND") {
      return evaluateBooleanAst(ast.left, matchedSet) && evaluateBooleanAst(ast.right, matchedSet);
    }
    if (ast.type === "OR") {
      return evaluateBooleanAst(ast.left, matchedSet) || evaluateBooleanAst(ast.right, matchedSet);
    }
    return false;
  }

  /**
   * True when `text` is SR's candidate-summary sidebar / profile chrome rather than
   * the real resume PDF.  getResumeText's fullRoot fallback returns this ~1000-char
   * boilerplate ("Candidate summary · High priority skills X/8 · Other skills X/33 ·
   * See details · Order assessments") whenever the PDF text layer has not rendered.
   * It sneaks past a length-only retry gate, so we detect it by content instead and
   * force the resume wait to keep trying for the actual PDF.
   *
   * The markers below are SR UI strings that never appear inside a candidate's
   * resume, so a false positive on real resume text is effectively impossible.
   * @param {unknown} text
   */
  function looksLikeSrSummaryChrome(text) {
    if (!text) return false;
    var t = String(text);
    var hits = 0;
    if (/candidate summary/i.test(t)) hits++;
    if (/\bOther skills\b|\bHigh priority skills\b/i.test(t)) hits++;
    if (/order assessments|no assessment orders/i.test(t)) hits++;
    if (/no tags added for this candidate/i.test(t)) hits++;
    if (/See details\b/i.test(t) && /View Profile\b/i.test(t)) hits++;
    return hits >= 2;
  }

  var api = {
    expandOneBooleanTerm: expandOneBooleanTerm,
    normalizeForKw: normalizeForKw,
    dedupeTextSegments: dedupeTextSegments,
    collapseInlineRepeats: collapseInlineRepeats,
    sepFlexiblePatternSource: sepFlexiblePatternSource,
    isoListHit: isoListHit,
    buildTokenIndex: buildTokenIndex,
    _KW_SFX: _KW_SFX,
    kwHitsInIndex: kwHitsInIndex,
    findKeywordHits: findKeywordHits,
    deduplicateHitsByCanonical: deduplicateHitsByCanonical,
    countsFromResume: countsFromResume,
    tokenizeBoolean: tokenizeBoolean,
    parseBooleanQuery: parseBooleanQuery,
    extractLeafTerms: extractLeafTerms,
    evaluateBooleanAst: evaluateBooleanAst,
    looksLikeSrSummaryChrome: looksLikeSrSummaryChrome,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.__srKw = Object.assign(globalThis.__srKw || {}, api);
})();
