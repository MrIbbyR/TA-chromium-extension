// location-infer.js — candidate location for the keyword note.
// The SR profile's location field wins ("verified"); when it is empty the
// location is inferred from the resume text the keyword scan already extracted,
// then from the phone's country code. Port of ATS-market-reporter/req.py
// (get_profile_dom_location → infer_location_from_resume) without spaCy NER or
// OCR, which can't ship in the extension: every city candidate is checked
// against location-gazetteer.js instead.
// Pure functions over strings — nothing is stored (see GDPR Data Handling).
// Exposes: __srLocation (content scripts) and module.exports (Node tests).

(function (root) {
  "use strict";

  var GAZ = (typeof SR_LOCATION_GAZETTEER !== "undefined" && SR_LOCATION_GAZETTEER) ||
    (typeof require === "function" ? require("./location-gazetteer.js") : null);

  /* ── Gazetteer index (built on first use, not at injection) ── */

  function fold(s) {
    return String(s == null ? "" : s).normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/\s+/g, " ").trim();
  }

  var IDX = null;
  function idx() {
    if (IDX) return IDX;
    IDX = { countryByName: {}, countryNameByIso: {}, cityByName: {}, regionByIso: {} };
    var g = GAZ || { countries: [], countryAliases: {}, cities: [], cityAliases: {}, regions: {} };
    g.countries.forEach(function (c) {
      IDX.countryNameByIso[c[0]] = c[1];
      IDX.countryByName[fold(c[1])] = c[0];
    });
    Object.keys(g.countryAliases).forEach(function (a) { IDX.countryByName[fold(a)] = g.countryAliases[a]; });
    g.cities.forEach(function (c) {
      var k = fold(c[0]);
      (IDX.cityByName[k] = IDX.cityByName[k] || []).push({ name: c[0], cc: c[1], pop: c[2] * 1000 });
    });
    Object.keys(g.cityAliases).forEach(function (a) {
      var t = g.cityAliases[a];
      var recs = (IDX.cityByName[fold(t[0])] || []).filter(function (r) { return r.cc === t[1]; });
      if (!recs.length) return;
      var k = fold(a);
      var list = (IDX.cityByName[k] = IDX.cityByName[k] || []);
      recs.forEach(function (r) { if (list.indexOf(r) < 0) list.push(r); });
    });
    Object.keys(g.regions).forEach(function (iso) {
      var m = (IDX.regionByIso[iso] = {});
      g.regions[iso].forEach(function (r) { m[fold(r)] = r; });
    });
    return IDX;
  }

  // Words that are also gazetteer cities but show up in resumes as ordinary
  // words (contact labels, tech terms).
  var NOT_A_CITY = {};
  ("mobile reading phone email home march may june university college school sale bath orange " +
   "independence victoria aurora phoenix")
    .split(" ").forEach(function (w) { NOT_A_CITY[w] = true; });
  var STOPWORDS = {};
  "of and or in for with to on at by from".split(" ").forEach(function (w) { STOPWORDS[w] = true; });
  var TECH_BLOCK = {};
  ("sql git nlp cnn ml ai dl tlp rpa etl ocr api rest grpc json xml soap jira tableau powerbi power bi " +
   "excel pandas numpy pytorch tensorflow keras opencv spark hadoop kafka airflow kubernetes docker " +
   "aws gcp azure react angular vue django flask spring kotlin swift golang c c++ c# php html css js")
    .split(" ").forEach(function (w) { TECH_BLOCK[w] = true; });

  function looksLikeTech(tok) {
    var raw = String(tok || "").replace(/[^\w]/g, "");
    return !!TECH_BLOCK[raw.toLowerCase()] || (raw === raw.toUpperCase() && /[A-Z]/.test(raw) && raw.length >= 2 && raw.length <= 4);
  }

  function countryIso(name) {
    var n = fold(name).replace(/[^\w\s.\-]/g, "").replace(/\.$/, "").trim();
    return idx().countryByName[n] || "";
  }
  function countryName(iso) { return idx().countryNameByIso[iso] || ""; }
  function cityRecs(name) {
    var k = fold(name);
    if (NOT_A_CITY[k] || TECH_BLOCK[k]) return [];
    return idx().cityByName[k] || [];
  }
  function regionName(iso, name) {
    var m = idx().regionByIso[iso];
    return (m && m[fold(name)]) || "";
  }

  /* ── String helpers ── */

  function clean(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  function stripContactsAndNoise(s) {
    return clean(String(s == null ? "" : s)
      .replace(/\S+@\S+/g, " ")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/\b(email|e-mail|phone|mobile|tel|github|linkedin|portfolio|website)\b[:\-]?/gi, " "));
  }

  function splitParts(s) {
    return String(s).split(/[,–|\/;]+|\s-\s/)
      .map(function (t) { return t.replace(/^[\s.]+|[\s.]+$/g, ""); })
      .filter(Boolean);
  }

  function toLines(text) {
    return String(text || "").replace(/\r/g, "").split("\n")
      .map(function (l) { return l.trim(); }).filter(Boolean);
  }

  /** The longest city name (3, 2 or 1 trailing words) a part ends with: "based in Pune" → "Pune". */
  function trailingCity(part, iso) {
    var words = part.split(/\s+/);
    for (var n = Math.min(3, words.length); n >= 1; n--) {
      var cand = words.slice(words.length - n).join(" ");
      if (cand.length < 3 || STOPWORDS[cand.toLowerCase()] || looksLikeTech(cand)) continue;
      var recs = cityRecs(cand).filter(function (r) { return r.cc === iso; });
      if (recs.length) return recs.sort(function (a, b) { return b.pop - a.pop; })[0];
    }
    return null;
  }

  /**
   * "12, MG Road, Kharadi, Pune, Maharashtra 411014" → "Pune, Maharashtra, India".
   * Needs a country (or an Indian state, which implies India) as the last part
   * and a gazetteer city in that country before it; a region alone gives
   * "West Bengal, India". House numbers and PIN codes are dropped. "" when unsure.
   */
  function normalizeLocationString(raw) {
    var parts = splitParts(stripContactsAndNoise(raw).replace(/\d+/g, " "));
    if (parts.length < 2) return "";
    var iso = countryIso(parts[parts.length - 1]);
    var impliedRegion = "";
    if (!iso && regionName("IN", parts[parts.length - 1])) {
      iso = "IN";
      impliedRegion = regionName("IN", parts[parts.length - 1]);
    }
    if (!iso) return "";
    var body = parts.slice(0, -1);
    for (var i = 0; i < body.length; i++) {
      var city = trailingCity(body[i], iso);
      if (!city) continue;
      var region = impliedRegion;
      if (!region && i + 1 < body.length) region = regionName(iso, body[i + 1]);
      return [city.name, region, countryName(iso)].filter(Boolean).join(", ");
    }
    var regionOnly = impliedRegion || (body.length ? regionName(iso, body[body.length - 1]) : "");
    return regionOnly ? regionOnly + ", " + countryName(iso) : "";
  }

  /* ── Profile field (SR's location slot) ── */

  /**
   * Port of req.py _sanitize_dom_loc: "Chennai, India" → "Chennai, India".
   * Rejects phone numbers, and text that reads like a job line
   * ("Engineer at Acme, India") rather than a place.
   */
  function normalizeDomLocation(val) {
    var s = stripContactsAndNoise(val);
    if (!s || /\+\d|\d{5,}/.test(s)) return "";
    var parts = splitParts(s);
    if (parts.length < 2) return "";
    var last = parts[parts.length - 1];
    var iso = countryIso(last);
    var tail = iso ? countryName(iso) : "";
    if (!iso && regionName("IN", last)) tail = regionName("IN", last) + ", India";
    if (!tail) return "";
    var left = parts.slice(0, -1);
    for (var i = 0; i < left.length; i++) {
      if (left[i].split(/\s+/).length > 4 || /\b(at|of|for)\b/i.test(left[i])) return "";
    }
    var lastLeft = left[left.length - 1];
    if (lastLeft.length < 3 || STOPWORDS[lastLeft.toLowerCase()]) return "";
    return left.join(", ") + ", " + tail;
  }

  /** A bare city in the profile slot ("Chennai"), from req.py get_dom_city_only. */
  function domCityOnly(texts) {
    for (var i = 0; i < (texts || []).length; i++) {
      var parts = splitParts(stripContactsAndNoise(texts[i]));
      if (!parts.length || countryIso(parts[parts.length - 1])) continue;
      for (var j = 0; j < parts.length; j++) {
        var p = parts[j];
        if (p.length >= 3 && !STOPWORDS[p.toLowerCase()] && !looksLikeTech(p) && cityRecs(p).length) {
          return cityRecs(p)[0].name;
        }
      }
    }
    return "";
  }

  /* ── Phone / email country hints ── */

  // Calling codes are prefix-free, so the first 1–3 digit prefix found is the code.
  var CALLING_CODES = {
    "1": "US", "7": "RU", "20": "EG", "27": "ZA", "30": "GR", "31": "NL", "32": "BE", "33": "FR",
    "34": "ES", "36": "HU", "39": "IT", "40": "RO", "41": "CH", "43": "AT", "44": "GB", "45": "DK",
    "46": "SE", "47": "NO", "48": "PL", "49": "DE", "51": "PE", "52": "MX", "54": "AR", "55": "BR",
    "56": "CL", "57": "CO", "60": "MY", "61": "AU", "62": "ID", "63": "PH", "64": "NZ", "65": "SG",
    "66": "TH", "81": "JP", "82": "KR", "84": "VN", "86": "CN", "90": "TR", "91": "IN", "92": "PK",
    "94": "LK", "212": "MA", "234": "NG", "254": "KE", "351": "PT", "353": "IE", "358": "FI",
    "380": "UA", "420": "CZ", "852": "HK", "880": "BD", "886": "TW", "965": "KW", "966": "SA",
    "968": "OM", "971": "AE", "972": "IL", "973": "BH", "974": "QA", "977": "NP",
  };

  function phoneIsosInLine(line) {
    var out = [];
    var re = /(?:^|[^\d+])\+\s?(\d{1,3})[\d\s\-().]{6,}/g, m;
    while ((m = re.exec(line))) {
      var d = m[1];
      for (var n = 1; n <= d.length; n++) {
        if (CALLING_CODES[d.slice(0, n)]) { out.push(CALLING_CODES[d.slice(0, n)]); break; }
      }
    }
    return out;
  }

  function topVote(counts) {
    var best = "", n = 0;
    Object.keys(counts).forEach(function (k) { if (counts[k] > n) { best = k; n = counts[k]; } });
    return best;
  }

  function phoneIsoVote(lines) {
    var counts = {};
    lines.forEach(function (l) { phoneIsosInLine(l).forEach(function (iso) { counts[iso] = (counts[iso] || 0) + 1; }); });
    return topVote(counts);
  }

  var CC_TLD_TO_ISO = {
    al: "AL", ba: "BA", bg: "BG", cz: "CZ", de: "DE", dk: "DK", ee: "EE", es: "ES", fi: "FI", fr: "FR",
    gr: "GR", hr: "HR", hu: "HU", ie: "IE", it: "IT", lt: "LT", lv: "LV", nl: "NL", no: "NO", pl: "PL",
    pt: "PT", ro: "RO", rs: "RS", se: "SE", si: "SI", sk: "SK", tr: "TR", ua: "UA", uk: "GB",
  };

  function emailIsoVote(lines) {
    var counts = {};
    lines.forEach(function (l) {
      var re = /\b[A-Z0-9._%+\-]+@([A-Z0-9.\-]+\.[A-Z]{2,})\b/gi, m;
      while ((m = re.exec(l))) {
        var iso = CC_TLD_TO_ISO[m[1].toLowerCase().split(".").pop()];
        if (iso) counts[iso] = (counts[iso] || 0) + 1;
      }
    });
    return topVote(counts);
  }

  function countryFromPhone(phone) {
    var isos = phoneIsosInLine(" " + (phone || ""));
    return isos.length ? countryName(isos[0]) : "";
  }

  /* ── Gazetteer scoring (req.py _collect_candidates / _score_candidates) ── */

  var SCORE_MIN = 8;
  var LOCATION_LABELS = ["location", "based", "based in", "city", "town", "country", "address",
    "current location", "present location", "presently in", "resides in", "living in", "lives in",
    "residence", "home", "base", "place"];
  var EXPERIENCE_HEADERS = { "experience": 1, "work experience": 1, "employment": 1, "work history": 1,
    "professional experience": 1, "projects": 1 };

  function words(lineFolded) {
    return (lineFolded.match(/[a-z][a-z.\-]+|\d+/g) || []).map(function (w) { return w.replace(/[.\-]+$/, ""); });
  }
  function ngrams(tokens, n) {
    var out = [];
    for (var i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(" "));
    return out;
  }

  function headerLineCount(lines) {
    var total = lines.reduce(function (a, l) { return a + l.length; }, 0);
    // req.py uses min(700, total/6), which is 0 lines for a short text; keep at least 200 chars.
    var limit = Math.min(700, Math.max(200, Math.floor(total / 6))), acc = 0, n = 0;
    for (var i = 0; i < lines.length; i++) {
      acc += lines[i].length + 1;
      // The header also ends at the first Experience-type heading, so an
      // employer's city on a short resume is never read as the candidate's.
      if (acc > limit || isExperienceHeader(lines[i])) break;
      n++;
    }
    return n;
  }

  function isExperienceHeader(line) {
    return !!EXPERIENCE_HEADERS[fold(line).replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim()];
  }

  function scoreCandidates(lines) {
    var cands = [], countryByLine = {};
    lines.forEach(function (line, i) {
      var toks = words(fold(line));
      for (var n = 3; n >= 1 && !countryByLine[i]; n--) {
        var g = ngrams(toks, n);
        for (var k = 0; k < g.length; k++) {
          var iso = idx().countryByName[g[k]];
          if (iso && g[k] !== "us") { countryByLine[i] = iso; break; }
        }
      }
      var seen = {};
      [3, 2, 1].forEach(function (n) {
        ngrams(toks, n).forEach(function (ng) {
          if (seen[ng] || ng.length < 3 || STOPWORDS[ng]) return;
          var recs = cityRecs(ng);
          if (!recs.length) return;
          seen[ng] = true;
          recs.forEach(function (r) { cands.push({ city: r, line: i, text: line, score: 0, reasons: [] }); });
        });
      });
    });
    if (!cands.length) return cands;

    var nHeader = headerLineCount(lines);
    var freq = {};
    cands.forEach(function (c) { var k = fold(c.city.name) + "|" + c.city.cc; freq[k] = (freq[k] || 0) + 1; });
    var expStart = -1;
    for (var e = 0; e < lines.length; e++) {
      if (isExperienceHeader(lines[e])) { expStart = e; break; }
    }
    var emailIso = emailIsoVote(lines);
    function bump(c, pts, why) { c.score += pts; c.reasons.push(why); }

    cands.forEach(function (c) {
      var lineL = fold(c.text);
      if (c.city.pop >= 5000000) bump(c, 2, "pop>5M");
      else if (c.city.pop >= 1000000) bump(c, 1, "pop>1M");
      if (c.line < nHeader) bump(c, 5, "header");
      if (LOCATION_LABELS.some(function (l) { return lineL.indexOf(l) >= 0; })) bump(c, 3, "label");
      var iso = countryByLine[c.line];
      if (iso) bump(c, iso === c.city.cc ? 4 : 1, iso === c.city.cc ? "country_match" : "country_present");
      if (phoneIsosInLine(c.text).indexOf(c.city.cc) >= 0) bump(c, 2, "phone_cc_match");
      if (emailIso && emailIso === c.city.cc) bump(c, 1, "email_tld_match");
      var f = freq[fold(c.city.name) + "|" + c.city.cc];
      if (f > 1) bump(c, Math.min(4, f - 1), "repeat");
      if (expStart >= 0 && c.line >= expStart) bump(c, -2, "in_experience");
      var esc = fold(c.city.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp("\\b" + esc + "\\b\\s*[,|\\-]\\s*[a-z ]+$").test(lineL)) bump(c, 2, "city_country_pattern");
    });
    return cands;
  }

  /** Strict pick, as req.py with STRICT_LOC_MODE: score ≥ 8, in the header, country confirmed. */
  function pickBest(cands) {
    if (!cands.length) return null;
    cands.sort(function (a, b) { return (b.score - a.score) || (b.city.pop - a.city.pop); });
    var top = cands[0];
    if (top.score < SCORE_MIN) return null;
    if (top.reasons.indexOf("header") < 0) return null;
    if (top.reasons.indexOf("country_match") < 0 && top.reasons.indexOf("city_country_pattern") < 0) return null;
    return top;
  }

  function headerSingleCityInIso(lines, iso) {
    var n = headerLineCount(lines), best = null;
    for (var i = 0; i < n; i++) {
      var toks = words(fold(lines[i]));
      [3, 2, 1].forEach(function (k) {
        ngrams(toks, k).forEach(function (ng) {
          if (ng.length < 3 || STOPWORDS[ng]) return;
          cityRecs(ng).forEach(function (r) { if (r.cc === iso && (!best || r.pop > best.pop)) best = r; });
        });
      });
    }
    return best ? best.name : "";
  }

  var LABEL_LINE = /\b(?:current location|present location|location|address|based in|based out of|residing in|resides in|residence|lives in|living in|locality|city)\b\s*[:\-—]?\s*(.*)$/i;
  var PAIR_RE = /([A-Za-z][A-Za-z .'\-]{1,40})\s*,\s*([A-Za-z][A-Za-z .'\-]{1,40})(?:\s*,\s*([A-Za-z][A-Za-z .'\-]{1,40}))?/g;

  /** req.py infer_location_from_resume_details: labels → "City, Country" pairs → scoring → phone/email country. */
  function inferDetails(text, domCity) {
    var lines = toLines(text);
    var head = lines.slice(0, 100);

    for (var i = 0; i < head.length; i++) {
      var m = LABEL_LINE.exec(head[i]);
      if (!m) continue;
      var value = m[1] || "";
      if (!/[A-Za-z]/.test(value) && i + 1 < head.length) value = head[i + 1]; // "Location" heading, value below
      var cand = normalizeLocationString(value);
      if (cand) return { location: cand, method: "label", score: 99 };
    }

    for (var j = 0; j < head.length; j++) {
      if (/\b(skills?|technolog(y|ies)|tools?|frameworks?)\b/i.test(head[j])) continue;
      PAIR_RE.lastIndex = 0;
      var p;
      while ((p = PAIR_RE.exec(head[j]))) {
        var toks = [p[1], p[2], p[3]].filter(Boolean);
        var last = toks[toks.length - 1];
        if (!countryIso(last) && !regionName("IN", last)) continue;
        var pc = normalizeLocationString(toks.join(", "));
        if (pc) return { location: pc, method: "city_country_pair", score: 90 };
      }
    }

    var best = pickBest(scoreCandidates(lines));
    if (best) return { location: best.city.name + ", " + countryName(best.city.cc), method: "gazetteer_score", score: best.score };

    var iso = phoneIsoVote(lines) || emailIsoVote(lines);
    if (!iso) return null;
    var city = headerSingleCityInIso(lines, iso);
    if (!city && domCity && cityRecs(domCity).some(function (r) { return r.cc === iso; })) city = domCity;
    if (city) return { location: city + ", " + countryName(iso), method: "header_city_phone_country", score: SCORE_MIN };
    return null;
  }

  /** req.py _extract_contact_block: lines before the first section heading, plus labelled lines anywhere. */
  function contactBlock(text) {
    var lines = toLines(text), out = [], seen = {};
    var stop = /^(experience|work history|employment|professional experience|education|skills|summary|profile)\b/i;
    for (var i = 0; i < lines.length && out.length < 80; i++) {
      if (stop.test(lines[i])) break;
      out.push(lines[i]);
    }
    lines.forEach(function (l) { if (/\b(address|location|based in|city|country|residing|residence)\b/i.test(l)) out.push(l); });
    return out.filter(function (l) { var k = l.toLowerCase(); if (seen[k]) return false; seen[k] = true; return true; }).join("\n");
  }

  /**
   * Location from resume text: contact block first (high precision), then the
   * whole resume. Returns { location, method, score } or null.
   */
  function inferLocationFromResume(resumeText, phone, domCity) {
    var text = String(resumeText || "");
    if (!text.trim()) return null;
    var phoneLine = phone ? "\nPhone: " + phone : "";
    var r = inferDetails(contactBlock(text) + phoneLine, domCity);
    if (r) { r.method = "contact_" + r.method; return r; }
    return inferDetails(text + phoneLine, domCity);
  }

  /**
   * Profile field first, then the resume, then the phone's country code.
   * input: { slotTexts, otherTexts, resumeText, phone }
   *   slotTexts  — text of SR's location slot (first personal-info item)
   *   otherTexts — the rest of sr-candidate-personal-info (title line, phone…)
   *   resumeText — only when the resume was actually read (not SR chrome)
   * Returns { location, source: "profile" | "resume" | "phone", method } or null.
   */
  function resolveCandidateLocation(input) {
    input = input || {};
    var slot = input.slotTexts || [];
    var dom = slot.concat(input.otherTexts || []);
    for (var i = 0; i < dom.length; i++) {
      var d = normalizeDomLocation(dom[i]);
      if (d) return { location: d, source: "profile", method: "profile_field" };
    }
    var domCity = domCityOnly(slot);
    if (domCity) return { location: domCity, source: "profile", method: "profile_city" };
    var r = inferLocationFromResume(input.resumeText, input.phone, "");
    if (r) return { location: r.location, source: "resume", method: r.method, score: r.score };
    var c = countryFromPhone(input.phone) || "";
    if (!c && input.resumeText) c = countryName(phoneIsoVote(toLines(input.resumeText)));
    if (c) return { location: c, source: "phone", method: "phone_country" };
    return null;
  }

  var SOURCE_LABEL = { profile: "verified", resume: "from resume", phone: "from phone" };

  /** "Pune, India (verified)" / "Pune, India (from resume)" / "India (from phone)". */
  function formatLocationLabel(res) {
    if (!res || !res.location) return "";
    return res.location + (SOURCE_LABEL[res.source] ? " (" + SOURCE_LABEL[res.source] + ")" : "");
  }

  var api = {
    normalizeLocationString: normalizeLocationString,
    normalizeDomLocation: normalizeDomLocation,
    domCityOnly: domCityOnly,
    inferLocationFromResume: inferLocationFromResume,
    resolveCandidateLocation: resolveCandidateLocation,
    formatLocationLabel: formatLocationLabel,
    countryFromPhone: countryFromPhone,
  };
  root.__srLocation = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
