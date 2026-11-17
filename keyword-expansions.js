// keyword-expansions.js — shared expansion table: loaded by popup.html + content scripts
// Exposes globals: KEYWORD_SYNONYM_GROUPS, KEYWORD_EXPANSIONS, KEYWORD_TYPO_ALIASES, resolveKeywords, buildExpansionTable, expansionsFor

/* exported KEYWORD_SYNONYM_GROUPS, KEYWORD_EXPANSIONS, KEYWORD_TYPO_ALIASES, resolveKeywords, buildExpansionTable, expansionsFor,
            parseKeywordsFromString, canonicalizeKeywords, expandKeywords, applyTypoAliases */

var _RD = ["research and development", "research & development", "r and d", "r&d"];

// ── Synonym groups ──
// One line per skill: every way a CV might write it. Each form finds every other
// form, in keyword and boolean search alike. Add a skill here as one line.
// Case, hyphens/spaces/joined words ("Google-Cloud", "GoogleCloud") and plural
// endings are matched automatically — list only genuinely different spellings.
// A form must be proof of the skill on its own: no common words, no other products.
var KEYWORD_SYNONYM_GROUPS = [
  // Cloud
  ["aws", "amazon web services", "amazon web service", "amazon cloud services", "amazon cloud service", "amazon cloud", "aws cloud"],
  ["gcp", "google cloud platform", "google cloud", "google cloud services", "gcloud"],
  ["azure", "microsoft azure", "ms azure", "azure cloud", "windows azure"],
  ["kubernetes", "k8s"],
  ["gke", "google kubernetes engine"],
  ["eks", "amazon elastic kubernetes service", "elastic kubernetes service"],
  ["aks", "azure kubernetes service"],

  // ML / AI
  ["ml", "machine learning"],
  ["dl", "deep learning"],
  ["ai", "artificial intelligence"],
  ["nlp", "natural language processing"],
  ["llm", "llms", "large language model"],
  ["rag", "retrieval augmented generation"],
  ["mlops", "ml ops", "machine learning operations", "ml operations"],
  ["pytorch", "py torch"],
  ["tensorflow", "tensor flow"],
  ["sklearn", "scikit-learn"],
  ["xgboost", "xgb"],
  ["lightgbm", "lgbm", "light gbm"],
  ["huggingface", "hugging face"],

  // Identity & access
  ["sso", "single sign-on"],
  ["mfa", "2fa", "multi-factor authentication", "two-factor authentication"],
  ["oidc", "openid connect"],
  ["iam", "identity and access management", "identity access management"],
  ["pam", "privileged access management"],
  ["iga", "identity governance and administration", "identity governance"],
  ["azure ad", "azure active directory", "entra id", "microsoft entra", "entra"],
  ["sailpoint", "sail point"],
  ["cyberark", "cyber ark"],
  ["forgerock", "forge rock"],
  ["beyondtrust", "beyond trust"],
  ["pingidentity", "ping identity"],
  ["pingfederate", "ping federate"],

  // Domain
  ["fmcg", "fast moving consumer goods"],
  ["cpg", "consumer packaged goods"],
  ["ctf", "capture the flag"],
  ["ner", "named entity recognition"],
  ["ocr", "optical character recognition"],
  ["sql", "structured query language"],
  ["nosql", "no sql"],
  ["resilience", "resiliency"],
];

// ── One-way extras ──
// Searching the key also finds these, but not the other way round — they are
// related or broader terms, not the same skill (searching "container" must not
// tag Docker). Groups above are merged in by buildExpansionTable().
var KEYWORD_EXPANSIONS = {
  // ── R&D ──
  "r&d": _RD, "r and d": _RD, "r & d": _RD,

  // ── ML / AI ──
  "deep learning":  ["neural network", "neural networks", "neural net"],
  // One-way only: every CV contains the word "CV", so "computer vision" must not find it.
  "cv":             ["computer vision"],

  // ── Cloud ──
  "azure":          ["azure devops"],

  // ── Degrees ──
  "phd":                  ["ph.d", "ph.d.", "doctorate", "doctoral", "postdoctoral", "postdoc", "dphil", "doctor of philosophy"],
  "ph.d":                 ["phd", "ph.d.", "doctorate", "doctoral", "postdoctoral", "postdoc"],
  "ph.d.":                ["phd", "ph.d", "doctorate", "doctoral"],
  "doctorate":            ["phd", "ph.d", "doctoral", "postdoctoral", "doctor of philosophy"],
  "doctoral":             ["phd", "ph.d", "doctorate", "postdoctoral"],
  "postdoc":              ["postdoctoral", "phd", "doctoral", "doctorate"],
  "postdoctoral":         ["postdoc", "phd", "doctoral", "doctorate"],
  "dphil":                ["phd", "doctor of philosophy"],
  "doctor of philosophy": ["phd", "ph.d", "ph.d.", "doctorate", "doctoral", "dphil"],
  "ms":                   ["m.s", "m.s.", "master's", "masters", "msc", "m.sc"],
  "bsc":                  ["b.s", "b.s.", "bachelor's", "bachelors", "b.sc"],

  // ── ML frameworks ──
  "pytorch":      ["torch", "pytorch lightning"],
  "tensorflow":   ["tensorflow 2", "tf2", "tf.keras", "tf"],
  "tf":           ["tensorflow"],
  "keras":        ["tf.keras"],
  "xgboost":      ["gradient boosting"],
  "lightgbm":     ["light gradient boosting"],
  "catboost":     ["cat boost", "gradient boosting"],

  // ── LLMs / NLP ──
  "transformer":   ["transformers"],
  "transformers":  ["transformer"],
  "bert":          ["roberta", "distilbert", "hugging face transformers"],
  "huggingface":   ["hf transformers"],
  "hugging face":  ["hf transformers"],

  // ── MLOps / DevOps ──
  // Resumes often use compound forms (Dockerfile, Dockerized) without ever
  // writing "Docker" alone. The word-boundary check in the regex fallback
  // rejects these, so the canonical keyword misses unless the compounds are
  // listed as expansion forms.
  "docker":       ["containerization", "container", "dockerfile", "dockerfiles", "dockerized", "dockerize", "dockerise"],
  "dockerfile":   ["docker"],
  "ci/cd":        ["cicd", "ci cd", "continuous integration", "continuous deployment"],
  "cicd":         ["ci/cd", "continuous integration"],

  // ── Data engineering ──
  "pyspark":      ["apache spark", "spark ml", "spark mllib"],
  "apache spark": ["pyspark", "spark"],
  "nosql":        ["non-relational"],

  // ── Standards / domain ──
  "iso 45001":  ["iso45001", "iso-45001", "ohsms", "occupational health and safety"],
  "iso 9001":   ["iso9001", "iso-9001", "quality management"],
  "nebsh":      ["nebsh igc", "international general certificate"],
  "cpg":        ["packaged goods"],

  // ── API / misc ──
  "api":         ["application programming interface", "apis"],
  "ir":          ["information retrieval"],
  "idp":         ["intelligent document processing"],
  "resilience":  ["resilient"],
  "resiliency":  ["resilient"],

  // ── IAM ──
  "saml":             ["security assertion markup language"],
  "oauth":            ["oauth 2.0", "open authorization"],
  "ldap":             ["lightweight directory access protocol"],
  "active directory": ["microsoft active directory"],
  // ping: "Ping Identity"/"Ping Federate" already match "ping"; list the joined forms.
  "ping":             ["pingidentity", "pingfederate", "ping one"],
  "pingidentity":     ["pingfederate", "ping federate"],
  "sailpoint":        ["sailpoint iiq", "sailpoint identitynow"],
  "okta":             ["okta workforce", "okta verify", "okta sso"],
  "ciam":             ["customer identity and access management",
                       "consumer identity and access management",
                       "customer iam"],
};

var KEYWORD_TYPO_ALIASES = {
  pytroch:         "pytorch",
  pytoch:          "pytorch",
  tensorlfow:      "tensorflow",
  tensorfow:       "tensorflow",
  tenserflow:      "tensorflow",
  azuer:           "azure",
  resilence:       "resilience",
  reslience:       "resilience",
  resliency:       "resiliency",
  scikitlearn:     "scikit-learn",
  sckitlearn:      "scikit-learn",
  hugginface:      "hugging face",
  huggingfaces:    "hugging face",
  sailpiont:       "sailpoint",
  salipoint:       "sailpoint",
  pingidentiy:     "pingidentity",
  pingidentitiy:   "pingidentity",
};

function parseKeywordsFromString(s) {
  if (!s || !s.trim()) return [];
  var lines = s.split(/\n/);
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.charAt(0) === "#") continue;
    var parts = line.split(/[,;]+/);
    for (var j = 0; j < parts.length; j++) {
      var p = parts[j].trim();
      if (p) out.push(p);
    }
  }
  return out;
}

function canonicalizeKeywords(keywords) {
  var seenLower = {};
  var cleaned = [];
  for (var i = 0; i < keywords.length; i++) {
    var kw = (keywords[i] || "").trim();
    if (!kw) continue;
    var key = kw.toLowerCase();
    if (seenLower[key]) continue;
    seenLower[key] = true;
    cleaned.push(kw);
  }
  return cleaned;
}

function buildExpansionTable() {
  var table = {};
  function add(key, form) {
    if (key === form) return;
    var list = table[key] || (table[key] = []);
    if (list.indexOf(form) < 0) list.push(form);
  }
  for (var g = 0; g < KEYWORD_SYNONYM_GROUPS.length; g++) {
    var group = KEYWORD_SYNONYM_GROUPS[g];
    for (var i = 0; i < group.length; i++) {
      for (var j = 0; j < group.length; j++) add(group[i], group[j]);
    }
  }
  for (var k in KEYWORD_EXPANSIONS) {
    if (Object.prototype.hasOwnProperty.call(KEYWORD_EXPANSIONS, k)) {
      for (var f = 0; f < KEYWORD_EXPANSIONS[k].length; f++) add(k, KEYWORD_EXPANSIONS[k][f]);
    }
  }
  // Also file every entry under its compact key, so a search typed as "Single Sign On",
  // "single-sign-on" or "singlesignon" finds the "single sign-on" entry.
  var keys = Object.keys(table);
  for (var c = 0; c < keys.length; c++) {
    var ck = compactKey(keys[c]);
    if (ck === keys[c]) continue;
    for (var cf = 0; cf < table[keys[c]].length; cf++) add(ck, table[keys[c]][cf]);
  }
  return table;
}

/** Lowercase, letters and digits only: "Single Sign-On" → "singlesignon". */
function compactKey(term) {
  return String(term || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Forms the table lists for a term as typed, matched exactly first, then by compact key. */
function expansionsFor(table, term) {
  var low = String(term || "").trim().toLowerCase();
  return table[low] || table[compactKey(low)] || null;
}

function expandKeywords(keywords, expansionTable) {
  expansionTable = expansionTable || buildExpansionTable();
  var expanded = keywords.slice();
  var expandedLower = {};
  for (var i = 0; i < expanded.length; i++) expandedLower[expanded[i].toLowerCase()] = true;
  for (var k = 0; k < keywords.length; k++) {
    var key = (keywords[k] || "").trim().toLowerCase();
    if (!key) continue;
    var forms = expansionsFor(expansionTable, key);
    if (!forms) continue;
    for (var f = 0; f < forms.length; f++) {
      if (!expandedLower[forms[f].toLowerCase()]) {
        expanded.push(forms[f]);
        expandedLower[forms[f].toLowerCase()] = true;
      }
    }
  }
  return expanded;
}

function applyTypoAliases(keywords) {
  var out = [];
  for (var i = 0; i < keywords.length; i++) {
    var raw = (keywords[i] || "").trim();
    if (!raw) continue;
    var low = raw.toLowerCase();
    var canon = KEYWORD_TYPO_ALIASES[low];
    out.push(canon ? canon : raw);
  }
  return out;
}

function resolveKeywords(rawInput) {
  var table = buildExpansionTable();
  var parsed = parseKeywordsFromString(rawInput);
  var typoFixed = applyTypoAliases(parsed);
  var canon = canonicalizeKeywords(typoFixed);
  var expanded = expandKeywords(canon, table);
  return canonicalizeKeywords(expanded);
}

/**
 * Like resolveKeywords but also returns a canonicalMap so callers can fold
 * expansion aliases back to the keyword the user actually typed.
 *
 * Returns:
 *   keywords    — full expanded + deduped list (same as resolveKeywords)
 *   canonicalMap — { [lowerForm]: userTypedCanonical }
 *   userCount   — number of keywords before expansion (the user-typed set)
 *
 * Rules:
 *   • Every user-typed keyword maps to itself.
 *   • Every auto-expansion maps to the user keyword that generated it,
 *     UNLESS it was also typed directly by the user (in which case it maps
 *     to itself and is its own canonical group).
 */
function resolveKeywordsWithMeta(rawInput) {
  var table = buildExpansionTable();
  var parsed = parseKeywordsFromString(rawInput);
  var typoFixed = applyTypoAliases(parsed);
  var userKeywords = canonicalizeKeywords(typoFixed);

  var canonicalMap = Object.create(null);
  for (var i = 0; i < userKeywords.length; i++) {
    canonicalMap[userKeywords[i].toLowerCase()] = userKeywords[i];
  }

  var expanded = userKeywords.slice();
  var expandedLower = Object.create(null);
  for (var ei = 0; ei < expanded.length; ei++) expandedLower[expanded[ei].toLowerCase()] = true;

  for (var k = 0; k < userKeywords.length; k++) {
    var key = userKeywords[k].toLowerCase();
    var forms = expansionsFor(table, key);
    if (!forms) continue;
    for (var f = 0; f < forms.length; f++) {
      var fl = forms[f].toLowerCase();
      if (expandedLower[fl]) continue;
      expanded.push(forms[f]);
      expandedLower[fl] = true;
      if (!canonicalMap[fl]) canonicalMap[fl] = userKeywords[k];
    }
  }

  return {
    keywords: canonicalizeKeywords(expanded),
    canonicalMap: canonicalMap,
    userCount: userKeywords.length,
    userKeywordsList: userKeywords.slice(),
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    KEYWORD_SYNONYM_GROUPS: KEYWORD_SYNONYM_GROUPS,
    KEYWORD_EXPANSIONS: KEYWORD_EXPANSIONS,
    KEYWORD_TYPO_ALIASES: KEYWORD_TYPO_ALIASES,
    resolveKeywords: resolveKeywords,
    resolveKeywordsWithMeta: resolveKeywordsWithMeta,
    buildExpansionTable: buildExpansionTable,
    expansionsFor: expansionsFor,
    parseKeywordsFromString: parseKeywordsFromString,
    canonicalizeKeywords: canonicalizeKeywords,
    expandKeywords: expandKeywords,
    applyTypoAliases: applyTypoAliases,
  };
}
