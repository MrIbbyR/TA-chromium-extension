'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeForKw,
  buildTokenIndex,
  kwHitsInIndex,
  sepFlexiblePatternSource,
  isoListHit,
  findKeywordHits,
  deduplicateHitsByCanonical,
  formatNoteText,
  formatNoteHtml,
  displayKeywordLabel,
  dedupeTextSegments,
  collapseInlineRepeats,
  noteConfirmMarker,
  feedDeltaCount,
  looksLikeSrSummaryChrome,
  resumeWasRead,
  countsFromResume,
} = require('../keyword-triage-core.js');
const { resolveKeywordsWithMeta } = require('../keyword-expansions.js');

describe('normalizeForKw', () => {
  it('strips zero-width chars', () => {
    assert.strictEqual(normalizeForKw('Pyth​on'), 'Python');
  });
  it('normalises non-breaking spaces to regular space', () => {
    assert.strictEqual(normalizeForKw('A B'), 'A B');
  });
  it('collapses runs of whitespace', () => {
    assert.strictEqual(normalizeForKw('A   B'), 'A B');
  });
  it('NFKC form: ﬁ → fi', () => {
    assert.strictEqual(normalizeForKw('ﬁeld'), 'field');
  });
  it('trims leading/trailing whitespace', () => {
    assert.strictEqual(normalizeForKw('  hello  '), 'hello');
  });
});

describe('buildTokenIndex + kwHitsInIndex', () => {
  it('unigram match', () => {
    const idx = buildTokenIndex('Python developer with 3 years');
    assert.ok(kwHitsInIndex('python', idx, false) > 0);
  });

  it('bigram match', () => {
    const idx = buildTokenIndex('machine learning engineer');
    assert.ok(kwHitsInIndex('machine learning', idx, false) > 0);
  });

  it('trigram match', () => {
    const idx = buildTokenIndex('natural language processing skills');
    assert.ok(kwHitsInIndex('natural language processing', idx, false) > 0);
  });

  it('4-token phrase returns -1 (signals regex fallback)', () => {
    const idx = buildTokenIndex('anything');
    assert.strictEqual(kwHitsInIndex('one two three four', idx, false), -1);
  });

  it('unigram not present returns 0', () => {
    const idx = buildTokenIndex('Java Spring Boot');
    assert.strictEqual(kwHitsInIndex('python', idx, false), 0);
  });

  it('suffix variants match — "publications" matches keyword "publication"', () => {
    const idx = buildTokenIndex('authored several publications');
    assert.ok(kwHitsInIndex('publication', idx, false) > 0);
  });

  it('CamelCase splitting — "TensorFlow" in text matches keyword "tensor flow"', () => {
    const idx = buildTokenIndex(normalizeForKw('experience with TensorFlow'));
    assert.ok(kwHitsInIndex('tensor flow', idx, false) > 0);
  });

  it('wildcard prefix matches all tokens starting with prefix', () => {
    const idx = buildTokenIndex('python pythonic pythonista');
    assert.ok(kwHitsInIndex('python', idx, true) >= 3);
  });
});

describe('sepFlexiblePatternSource', () => {
  it('generates separator-flexible pattern that matches hyphenated form', () => {
    const src = sepFlexiblePatternSource('gpt4', true);
    const rx = new RegExp(src, 'gi');
    assert.ok(rx.test('GPT-4'));
  });

  it('matches hyphenated form', () => {
    const src = sepFlexiblePatternSource('scikit learn', true);
    assert.ok(new RegExp(src, 'i').test('scikit-learn'));
  });

  it('matches underscore-separated form', () => {
    const src = sepFlexiblePatternSource('scikit learn', true);
    assert.ok(new RegExp(src, 'i').test('scikit_learn'));
  });
});

describe('isoListHit — fix 3: proximity window on normalised (newline-free) text', () => {
  it('detects ISO number within proximity of ISO keyword', () => {
    // normalizeForKw removes newlines, so chunks in the original code were useless
    const hay = normalizeForKw('Certified to ISO Standard 9001 and 45001');
    assert.strictEqual(isoListHit(hay, '45001'), true);
  });

  it('does not match when number is far from ISO keyword', () => {
    // number 45001 appears but 400+ chars away from "ISO"
    const hay = 'ISO certified ' + 'x'.repeat(400) + ' 45001';
    assert.strictEqual(isoListHit(hay, '45001'), false);
  });

  it('handles no ISO keyword', () => {
    assert.strictEqual(isoListHit('certified to standard 9001', '9001'), false);
  });

  it('empty num returns false', () => {
    assert.strictEqual(isoListHit('ISO 9001', ''), false);
  });
});

describe('findKeywordHits', () => {
  it('finds a simple unigram keyword', () => {
    const { hitCount, hits } = findKeywordHits('Experienced Python developer', ['Python']);
    assert.strictEqual(hitCount, 1);
    assert.strictEqual(hits[0].keyword, 'Python');
  });

  it('case-insensitive match', () => {
    const { hitCount } = findKeywordHits('python and TENSORFLOW', ['Python', 'TensorFlow']);
    assert.strictEqual(hitCount, 2);
  });

  it('fix 2: compound form "GPT-4" matched by keyword "gpt4" via regex fallback', () => {
    // Token index splits "GPT-4" into ["gpt","4"] — unigram "gpt4" won't be in the index.
    // After fix 2, idxResult===0 falls through to sepFlexiblePatternSource regex.
    const { hitCount } = findKeywordHits('proficient in GPT-4 and GPT4 models', ['gpt4']);
    assert.ok(hitCount > 0, 'expected gpt4 to match GPT-4 via regex fallback');
  });

  it('ISO heuristic: "ISO 45001" matches text "ISO Standard (9001, 45001)"', () => {
    const text = normalizeForKw('Certified to ISO Standard (9001, 45001)');
    const { hitCount } = findKeywordHits(text, ['ISO 45001']);
    assert.ok(hitCount > 0, 'expected ISO 45001 to be found via isoListHit');
  });

  it('wildcard: "Python*" matches "Pythonic" and "Python3"', () => {
    const { hits } = findKeywordHits('built Pythonic Python3 tools', ['Python*']);
    assert.ok(hits.length > 0);
    assert.ok(hits[0].count >= 2);
  });

  it('counts multiple occurrences', () => {
    const { hits } = findKeywordHits('Python Python Python', ['Python']);
    assert.strictEqual(hits[0].count, 3);
  });

  it('no match returns empty hits and hitCount 0', () => {
    const { hitCount, hits } = findKeywordHits('Java Spring developer', ['Python']);
    assert.strictEqual(hitCount, 0);
    assert.strictEqual(hits.length, 0);
  });

  it('empty text returns no hits', () => {
    const { hitCount } = findKeywordHits('', ['Python', 'Java']);
    assert.strictEqual(hitCount, 0);
  });

  it('deduplicates same keyword (different case input)', () => {
    const { hitCount } = findKeywordHits('python', ['Python', 'python', 'PYTHON']);
    assert.strictEqual(hitCount, 1);
  });
});

describe('deduplicateHitsByCanonical', () => {
  it('collapses expansion aliases to the canonical form', () => {
    const hits = [
      { keyword: 'tensorflow', count: 2 },
      { keyword: 'tensor flow', count: 2 },
      { keyword: 'tensor-flow', count: 2 },
    ];
    const map = { tensorflow: 'tensorflow', 'tensor flow': 'tensorflow', 'tensor-flow': 'tensorflow' };
    const out = deduplicateHitsByCanonical(hits, map);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].keyword, 'tensorflow');
    assert.strictEqual(out[0].count, 2);
  });

  it('keeps distinct canonical keywords separate', () => {
    const hits = [
      { keyword: 'pytorch', count: 2 },
      { keyword: 'py torch', count: 2 },
      { keyword: 'tensorflow', count: 1 },
    ];
    const map = { pytorch: 'pytorch', 'py torch': 'pytorch', tensorflow: 'tensorflow' };
    const out = deduplicateHitsByCanonical(hits, map);
    assert.strictEqual(out.length, 2);
    assert.ok(out.some(h => h.keyword === 'pytorch' && h.count === 2));
    assert.ok(out.some(h => h.keyword === 'tensorflow' && h.count === 1));
  });

  it('uses max count across the alias group', () => {
    // e.g. standalone "torch" appears more often than "pytorch" itself
    const hits = [
      { keyword: 'pytorch', count: 1 },
      { keyword: 'torch', count: 3 },
    ];
    const map = { pytorch: 'pytorch', torch: 'pytorch' };
    const out = deduplicateHitsByCanonical(hits, map);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].count, 3);
  });

  it('reports canonical name even when only an expansion matched', () => {
    // resume says "py torch" never "pytorch"
    const hits = [{ keyword: 'py torch', count: 2 }];
    const map = { pytorch: 'pytorch', 'py torch': 'pytorch', 'py-torch': 'pytorch' };
    const out = deduplicateHitsByCanonical(hits, map);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].keyword, 'pytorch');
    assert.strictEqual(out[0].count, 2);
  });

  it('is a no-op when canonicalMap is null', () => {
    const hits = [{ keyword: 'python', count: 1 }];
    const out = deduplicateHitsByCanonical(hits, null);
    assert.deepEqual(out, hits);
  });

  it('preserves insertion order of first canonical appearance', () => {
    const hits = [
      { keyword: 'py torch', count: 1 },
      { keyword: 'tensorflow', count: 1 },
      { keyword: 'pytorch', count: 1 },
    ];
    const map = { pytorch: 'pytorch', 'py torch': 'pytorch', tensorflow: 'tensorflow' };
    const out = deduplicateHitsByCanonical(hits, map);
    // "pytorch" group encountered first via "py torch", tensorflow second
    assert.strictEqual(out[0].keyword, 'pytorch');
    assert.strictEqual(out[1].keyword, 'tensorflow');
  });
});

describe('findKeywordHits + deduplicateHitsByCanonical integration', () => {
  it('PyTorch in text → one "pytorch" entry, not pytorch + py torch separately', () => {
    const text = 'Extensive experience with PyTorch and pytorch lightning';
    const { keywords, canonicalMap } = resolveKeywordsWithMeta('pytorch');
    const { hits } = findKeywordHits(text, keywords);
    const out = deduplicateHitsByCanonical(hits, canonicalMap);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].keyword, 'pytorch');
  });

  it('TensorFlow in text → one "tensorflow" entry, not three alias entries', () => {
    const text = 'Built production models in TensorFlow 2 and Keras';
    const { keywords, canonicalMap } = resolveKeywordsWithMeta('tensorflow');
    const { hits } = findKeywordHits(text, keywords);
    const out = deduplicateHitsByCanonical(hits, canonicalMap);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].keyword, 'tensorflow');
  });

  it('hitCount equals number of distinct user keywords found', () => {
    const text = 'Skilled in PyTorch, TensorFlow, and scikit-learn';
    const { keywords, canonicalMap, userCount } = resolveKeywordsWithMeta('pytorch, tensorflow, sklearn');
    const { hits } = findKeywordHits(text, keywords);
    const out = deduplicateHitsByCanonical(hits, canonicalMap);
    // All 3 user keywords should be found, regardless of how many aliases also matched
    assert.strictEqual(out.length, 3);
    assert.strictEqual(userCount, 3);
  });
});

describe('IAM tool keyword matching — two-word vs compound-word variants', () => {
  // These tests reproduce real failures: Ctrl+F finds "Ping Identity" / "Sail Point"
  // on a resume but the extension returned 0 hits because the engine matched only
  // the single-token compound form and not the space-separated two-word form.

  it('"pingidentity" keyword matches "Ping Identity" (two-word form in resume)', () => {
    const text = 'Senior IAM architect with Ping Identity and ForgeRock experience';
    const { keywords, canonicalMap } = resolveKeywordsWithMeta('pingidentity');
    const { hits } = findKeywordHits(text, keywords);
    const out = deduplicateHitsByCanonical(hits, canonicalMap);
    assert.ok(out.length > 0, 'pingidentity should match "Ping Identity"');
    assert.strictEqual(out[0].keyword, 'pingidentity');
  });

  it('"pingidentity" keyword matches "PingIdentity" (compound CamelCase in resume)', () => {
    const text = 'Administered PingIdentity SSO across enterprise';
    const { keywords, canonicalMap } = resolveKeywordsWithMeta('pingidentity');
    const { hits } = findKeywordHits(text, keywords);
    const out = deduplicateHitsByCanonical(hits, canonicalMap);
    assert.ok(out.length > 0, 'pingidentity should match "PingIdentity"');
  });

  it('"sailpoint" keyword matches "Sail Point" (two-word form in resume)', () => {
    const text = 'Led identity governance implementation using Sail Point IIQ';
    const { keywords, canonicalMap } = resolveKeywordsWithMeta('sailpoint');
    const { hits } = findKeywordHits(text, keywords);
    const out = deduplicateHitsByCanonical(hits, canonicalMap);
    assert.ok(out.length > 0, 'sailpoint should match "Sail Point"');
    assert.strictEqual(out[0].keyword, 'sailpoint');
  });

  it('"sailpoint" keyword matches "SailPoint" (CamelCase in resume)', () => {
    const text = 'Certified SailPoint IdentityIQ developer';
    const { keywords, canonicalMap } = resolveKeywordsWithMeta('sailpoint');
    const { hits } = findKeywordHits(text, keywords);
    const out = deduplicateHitsByCanonical(hits, canonicalMap);
    assert.ok(out.length > 0, 'sailpoint should match "SailPoint"');
  });

  it('"ping" and "pingidentity" both count as hits when resume says "Ping Identity"', () => {
    const text = '10 years Ping Identity experience across multiple clients';
    const { keywords, canonicalMap } = resolveKeywordsWithMeta('ping, pingidentity');
    const { hits } = findKeywordHits(text, keywords);
    const out = deduplicateHitsByCanonical(hits, canonicalMap);
    // Both user keywords should resolve to independent hits
    assert.ok(out.length >= 1, 'at least one of ping/pingidentity should match');
    const labels = out.map(h => h.keyword);
    assert.ok(labels.includes('ping') || labels.includes('pingidentity'),
      'hit should fold back to canonical user keyword name');
  });

  it('full IAM query — "Ping Identity" resume hits both ping and pingidentity canonicals', () => {
    // Simulates the user running: ping, sailpoint, okta, CIAM, migration, pingidentity
    const text = 'IAM architect, Ping Identity federation, SailPoint IIQ governance, Okta SSO, CIAM strategy';
    const { keywords, canonicalMap, userCount } = resolveKeywordsWithMeta(
      'ping, sailpoint, okta, CIAM, migration, pingidentity'
    );
    const { hits } = findKeywordHits(text, keywords);
    const out = deduplicateHitsByCanonical(hits, canonicalMap);
    const labels = out.map(h => h.keyword);
    assert.ok(labels.includes('ping'), 'ping should match "Ping Identity"');
    assert.ok(labels.includes('pingidentity'), 'pingidentity should match "Ping Identity"');
    assert.ok(labels.includes('sailpoint'), 'sailpoint should match "SailPoint IIQ"');
    assert.ok(labels.includes('okta'), 'okta should match');
    assert.ok(labels.includes('CIAM'), 'CIAM should match');
    assert.strictEqual(userCount, 6);
  });

  it('"ciam" keyword matches spelled-out "Customer Identity and Access Management"', () => {
    const text = 'Developed Customer Identity and Access Management platform using Auth0';
    const { keywords, canonicalMap } = resolveKeywordsWithMeta('CIAM');
    const { hits } = findKeywordHits(text, keywords);
    const out = deduplicateHitsByCanonical(hits, canonicalMap);
    assert.ok(out.length > 0, 'CIAM should match spelled-out form');
    assert.strictEqual(out[0].keyword, 'CIAM');
  });
});

describe('Docker compound-word containment (production miss: pic 5)', () => {
  // Reported in production: keyword "docker" missed on resumes that mention
  // "Dockerfile" or "Dockerized" but never say "Docker" as a standalone word.
  // The regex fallback rejects "Dockerfile" because the trailing boundary
  // (?![A-Za-z0-9]) fails on the "f" that follows "docker". Fix is to add
  // compound forms to the expansion table so the keyword resolver covers them.

  it('"docker" keyword matches "Dockerfile" in resume text', () => {
    const text = 'Authored the Dockerfile and CI pipeline for the service';
    const { keywords, canonicalMap } = resolveKeywordsWithMeta('docker');
    const { hits } = findKeywordHits(text, keywords);
    const out = deduplicateHitsByCanonical(hits, canonicalMap);
    assert.ok(out.length > 0, 'docker should match "Dockerfile"');
    assert.strictEqual(out[0].keyword, 'docker');
  });

  it('"docker" keyword matches "Dockerized" in resume text', () => {
    const text = 'Dockerized the legacy services and deployed to AKS';
    const { keywords, canonicalMap } = resolveKeywordsWithMeta('docker');
    const { hits } = findKeywordHits(text, keywords);
    const out = deduplicateHitsByCanonical(hits, canonicalMap);
    assert.ok(out.length > 0, 'docker should match "Dockerized"');
    assert.strictEqual(out[0].keyword, 'docker');
  });

  it('"docker" keyword still matches standalone "Docker" (no regression)', () => {
    const text = 'Containerized services with Docker and Kubernetes';
    const { keywords, canonicalMap } = resolveKeywordsWithMeta('docker');
    const { hits } = findKeywordHits(text, keywords);
    const out = deduplicateHitsByCanonical(hits, canonicalMap);
    assert.ok(out.length > 0);
    assert.strictEqual(out[0].keyword, 'docker');
  });
});

describe('formatNoteText', () => {
  it('lists location, match count, then one keyword per line under a "Name | URL" header', () => {
    const out = formatNoteText(
      ['keras (x2)', 'chennai', 'nlp'], 3, 13, '',
      'Mrinmayi Verma', 'https://jobs.smartrecruiters.com/abc', false, 'Chennai, India (verified)'
    );
    assert.strictEqual(
      out,
      'Mrinmayi Verma | https://jobs.smartrecruiters.com/abc\n' +
      'Location: Chennai, India (verified)\n\n' +
      'Keywords match 3/13:\n\n' +
      'Keras (x2)\n' +
      'Chennai\n' +
      'NLP'
    );
  });
  it('omits the location line when no location was found', () => {
    const out = formatNoteText(['Python', 'AWS'], 2, 5, '', 'Jane Smith', 'https://example.com/x');
    assert.strictEqual(out, 'Jane Smith | https://example.com/x\nKeywords match 2/5:\n\nPython\nAWS');
  });
  it('honours an existing note prefix on the match-count line', () => {
    const out = formatNoteText(['Python'], 1, 1, 'Boolean: ', 'Jane Smith', 'https://example.com/x');
    assert.strictEqual(out, 'Jane Smith | https://example.com/x\nBoolean: Keywords match 1/1:\n\nPython');
  });
  it('uses name alone when URL is missing', () => {
    const out = formatNoteText(['Go'], 1, 2, '', 'John Doe', '');
    assert.strictEqual(out, 'John Doe\nKeywords match 1/2:\n\nGo');
  });
  it('uses URL alone when name is missing', () => {
    const out = formatNoteText(['Go'], 1, 2, '', '', 'https://example.com/y');
    assert.strictEqual(out, 'https://example.com/y\nKeywords match 1/2:\n\nGo');
  });
  it('falls back to the bare list when name, URL and location are all absent', () => {
    const out = formatNoteText(['Go', 'Rust'], 2, 4, '');
    assert.strictEqual(out, 'Keywords match 2/4:\n\nGo\nRust');
  });
  it('writes a single "No keyword tagged" line (after the location) on zero hits', () => {
    const out = formatNoteText([], 0, 5, '', 'Jane Smith', 'https://x.test/a', false, 'Pune, India');
    assert.strictEqual(
      out,
      'Jane Smith | https://x.test/a\nLocation: Pune, India\n\nNo keyword tagged - Keywords match 0/5'
    );
  });
  it('keeps the prefix on a zero-hit summary (boolean FAIL)', () => {
    const out = formatNoteText([], 0, 3, '[FAIL] ', '', '');
    assert.strictEqual(out, '[FAIL] No keyword tagged - Keywords match 0/3');
  });
  it('appends the partial-scan warning last when the resume PDF was not read', () => {
    const out = formatNoteText(['phd'], 1, 5, '', 'Jane', 'https://x.test/a', true);
    assert.strictEqual(
      out,
      'Jane | https://x.test/a\nKeywords match 1/5:\n\nPhD\n⚠ Resume PDF not read — partial scan (profile data only)'
    );
  });
  it('says "Boolean match" for a boolean scan', () => {
    const out = formatNoteText(['python'], 1, 1, '[PASS] ', 'Jane', 'https://x.test/a', false, 'Pune, India', '', [], 'boolean');
    assert.strictEqual(out, 'Jane | https://x.test/a\nLocation: Pune, India\n\n[PASS] Boolean match 1/1:\n\nPython');
  });
  it('omits the warning when the scan was complete', () => {
    const out = formatNoteText(['phd'], 1, 5, '', 'Jane', 'https://x.test/a', false);
    assert.ok(!/partial scan/.test(out));
  });
});

describe('current role line', () => {
  const { pickCandidateHeadline } = require('../keyword-extract.js');
  it('puts "Current:" under the name, above the location', () => {
    const out = formatNoteText(['nlp'], 1, 5, '', 'Jane', 'https://x.test/a', false, 'Chennai, India (verified)',
      'Data Annotator at Samsung R&D Institute India');
    assert.strictEqual(out,
      'Jane | https://x.test/a\nCurrent: Data Annotator at Samsung R&D Institute India\n' +
      'Location: Chennai, India (verified)\n\nKeywords match 1/5:\n\nNLP');
  });
  it('escapes the role in the rich-text note', () => {
    const out = formatNoteHtml([], 0, 2, '', 'Jane', 'https://x.test/a', false, '', 'Engineer at R&D <Lab>');
    assert.ok(out.includes('<br>Current: Engineer at R&amp;D &lt;Lab&gt;<br><br>No keyword tagged'));
  });
  it('picks the "<title> at <company>" line, skipping location, phone and name', () => {
    assert.strictEqual(
      pickCandidateHeadline(['Chennai, Tamil Nadu, India', '+91 98765 43210',
        'Data Annotator at Samsung R&D Institute India - Bangalore(via SEED Data Lab, VIT Chennai)'], 'P P'),
      'Data Annotator at Samsung R&D Institute India - Bangalore(via SEED Data Lab, VIT Chennai)');
    assert.strictEqual(pickCandidateHeadline(['Jane Doe\nSRE @ Acme'], 'Jane Doe'), 'SRE @ Acme');
  });
  it('returns "" when no line has the role shape', () => {
    assert.strictEqual(pickCandidateHeadline(['Pune, India', 'Applied at 10:00'], ''), '');
  });
});

describe('salary lines from screening answers', () => {
  const { salaryNoteLines, parseSalaryBand } = require('../keyword-extract.js');
  const INDIA = 'Screening Questions\nPlease enter your Annual Current CTC in INR:\n2,00,000 to 5,00,000 INR\n\n' +
    'Please enter your Annual Expected CTC in INR:\n8,00,000 to 11,00,000 INR';
  it('normalises Indian bands to lakhs', () => {
    assert.deepEqual(salaryNoteLines(INDIA), ['Current CTC: 2–5 L INR', 'Expected CTC: 8–11 L INR']);
  });
  it('exact figures stay exact', () => {
    assert.deepEqual(salaryNoteLines('Current CTC:\n12 LPA\nExpected CTC:\n15 LPA'),
      ['Current CTC: 12 L INR', 'Expected CTC: 15 L INR']);
  });
  it('non-INR uses k and the question wording ("salary")', () => {
    assert.deepEqual(
      salaryNoteLines('What is your current gross annual salary?\n€45,000\nWhat are your salary expectations?\n50k - 55k EUR'),
      ['Current salary: 45k EUR', 'Expected salary: 50–55k EUR']);
  });
  it('marks a monthly figure', () => {
    assert.deepEqual(
      salaryNoteLines('Current monthly salary in USD?\n4,500\nExpected annual salary in USD?\n70000'),
      ['Current salary (monthly): 4.5k USD', 'Expected salary: 70k USD']);
  });
  it('keeps an unparseable answer as typed', () => {
    assert.deepEqual(salaryNoteLines('Expected CTC?\nNegotiable'), ['Expected CTC: Negotiable']);
  });
  it('ignores non-salary questions and empty text', () => {
    assert.deepEqual(salaryNoteLines('Notice period in days?\n30\nAre you willing to relocate?\nYes'), []);
    assert.deepEqual(salaryNoteLines(''), []);
  });
  it('parses open bands, units and currencies', () => {
    assert.deepEqual(parseSalaryBand('8 to 11 LPA'), { lo: 800000, hi: 1100000, currency: 'INR' });
    assert.deepEqual(parseSalaryBand('Above 30,00,000 INR'), { lo: 3000000, hi: null, currency: 'INR' });
    assert.deepEqual(parseSalaryBand('Up to 5 LPA'), { lo: null, hi: 500000, currency: 'INR' });
    assert.deepEqual(parseSalaryBand('$120,000 - $140,000'), { lo: 120000, hi: 140000, currency: 'USD' });
    assert.equal(parseSalaryBand('n/a'), null);
  });
  it('salary lines sit after the location, before the match count', () => {
    const out = formatNoteText(['aws'], 1, 2, '', 'Jane', 'https://x.test/a', false, 'Pune, India', 'SRE at Acme',
      ['Current CTC: 2–5 L INR', 'Expected CTC: 8–11 L INR']);
    assert.strictEqual(out,
      'Jane | https://x.test/a\nCurrent: SRE at Acme\nLocation: Pune, India\n' +
      'Current CTC: 2–5 L INR\nExpected CTC: 8–11 L INR\n\nKeywords match 1/2:\n\nAWS');
  });
});

describe('displayKeywordLabel — keywords in the note are capitalised', () => {
  it('capitalises a plain keyword and keeps the count', () => {
    assert.strictEqual(displayKeywordLabel('scrapy (x3)'), 'Scrapy (x3)');
    assert.strictEqual(displayKeywordLabel('reverse engineering'), 'Reverse Engineering');
    assert.strictEqual(displayKeywordLabel('data acquisition (x20)'), 'Data Acquisition (x20)');
  });
  it('uses the usual spelling of acronyms and tech names', () => {
    assert.strictEqual(displayKeywordLabel('waf (x2)'), 'WAF (x2)');
    assert.strictEqual(displayKeywordLabel('phd'), 'PhD');
    assert.strictEqual(displayKeywordLabel('aws lambda'), 'AWS Lambda');
    assert.strictEqual(displayKeywordLabel('pytorch'), 'PyTorch');
    assert.strictEqual(displayKeywordLabel('r&d'), 'R&D');
    assert.strictEqual(displayKeywordLabel('fmcg'), 'FMCG');
  });
  it('keeps small words lowercase inside a phrase', () => {
    assert.strictEqual(displayKeywordLabel('research and development'), 'Research and Development');
  });
  it('keeps hyphenated words readable', () => {
    assert.strictEqual(displayKeywordLabel('scikit-learn'), 'Scikit-Learn');
  });
  it('keeps the recruiter\'s own capitals', () => {
    assert.strictEqual(displayKeywordLabel('SailPoint (x3)'), 'SailPoint (x3)');
    assert.strictEqual(displayKeywordLabel('iPhone'), 'iPhone');
  });
});

describe('dedupeTextSegments', () => {
  it('collapses repeated chunks so occurrence counts are not inflated', () => {
    // Same education line captured 5× by overlapping profile selectors.
    const line = 'PhD in Computer Science, University of Madrid';
    const inflated = Array(5).fill(line).join('\n');
    const deduped = dedupeTextSegments(inflated);
    // Before: 5 occurrences of "phd"; after: 1.
    assert.strictEqual((deduped.match(/phd/gi) || []).length, 1);
    assert.strictEqual(findKeywordHits(inflated, ['phd']).hits[0].count, 5);
    assert.strictEqual(findKeywordHits(deduped, ['phd']).hits[0].count, 1);
  });
  it('preserves presence of every distinct segment (hit/miss unchanged)', () => {
    const text = 'Worked with NLP models\nWorked with NLP models\nBuilt PyTorch pipelines';
    const deduped = dedupeTextSegments(text);
    assert.ok(/nlp/i.test(deduped));
    assert.ok(/pytorch/i.test(deduped));
    assert.strictEqual((deduped.match(/nlp/gi) || []).length, 1);
  });
  it('keeps short (<12 char) segments verbatim even when repeated', () => {
    const deduped = dedupeTextSegments('Go\nGo\nRust');
    assert.strictEqual(deduped, 'Go\nGo\nRust');
  });
});

describe('countsFromResume', () => {
  const { keywords, canonicalMap } = resolveKeywordsWithMeta('phd');
  const filler = ' '.padEnd(0) + 'Experienced data scientist with a strong publication record and applied research background across multiple industry and academic projects spanning many years of work. ';

  it('counts phd from the resume (not inflated by profile chrome aliases)', () => {
    // Resume mentions PhD twice; no "doctorate" chrome here.
    const resume = 'Adrian Rubio. PhD in Physics at University of Valencia. ' + filler +
                   'Completed my PhD research in high energy physics in 2025. ' + filler;
    const map = countsFromResume(resume, keywords, canonicalMap);
    assert.strictEqual(map.phd, 2);
  });
  it('returns null for SR summary chrome (so caller keeps the union count)', () => {
    const chrome = 'Latest Resume More Candidate summary High priority skills 4/8 Other skills 2/33 ' +
      'Doctorate degree in and philosophy See details Profile Resume View Profile ' +
      'Order assessments No tags added for this candidate yet. ' + filler;
    assert.strictEqual(countsFromResume(chrome, keywords, canonicalMap), null);
  });
  it('returns null for sparse text (< 300 chars)', () => {
    assert.strictEqual(countsFromResume('PhD here', keywords, canonicalMap), null);
  });
});

describe('looksLikeSrSummaryChrome', () => {
  // Real ~1000-char sidebar boilerplate captured when the PDF text layer fails to
  // render (from the Gilberto/Ana diagnostics). Must be flagged so the retry fires.
  const srChrome =
    'Gilberto Jesús Brito AI / ML Engineer at SDG Group Valencian Community, Spain ' +
    'Latest Resume More Candidate summary High priority skills 4/8 Other skills 2/33 ' +
    'Worked in the engineer role for 2 years Doctorate degree in and philosophy ' +
    'See details Profile Resume View Profile Applicant profile ' +
    'Order assessments No tags added for this candidate yet.';
  // Real resume PDF body (from the Adrián diagnostics) — must NOT be flagged.
  const realResume =
    'Adrián Rubio Jiménez PhD in Physics ML engineer Data Scientist Valencia, Spain ' +
    'Professional Summary Working as an ML Engineer, researching on new methods for LLM ' +
    'compression. PhD in Physics at University of Valencia. ML libraries and tools: ' +
    'HuggingFace, PyTorch, TensorFlow, Keras, XGBoost.';

  it('flags SR candidate-summary sidebar chrome', () => {
    assert.strictEqual(looksLikeSrSummaryChrome(srChrome), true);
  });
  it('does not flag a real resume PDF body', () => {
    assert.strictEqual(looksLikeSrSummaryChrome(realResume), false);
  });
  it('returns false for empty/missing text', () => {
    assert.strictEqual(looksLikeSrSummaryChrome(''), false);
    assert.strictEqual(looksLikeSrSummaryChrome(null), false);
  });
});

describe('formatNoteHtml', () => {
  it('renders the profile URL as an "SR Profile" hyperlink and one keyword per line', () => {
    const out = formatNoteHtml(
      ['Python', 'AWS'], 2, 5, '',
      'Jane Smith', 'https://jobs.smartrecruiters.com/abc', false, 'Chennai, India'
    );
    assert.strictEqual(
      out,
      'Jane Smith | <a href="https://jobs.smartrecruiters.com/abc">SR Profile</a>' +
      '<br>Location: Chennai, India<br><br>Keywords match 2/5:<br><br>Python<br>AWS'
    );
  });
  it('renders "No keyword tagged" with the hyperlink on zero hits', () => {
    const out = formatNoteHtml([], 0, 4, '', 'John Doe', 'https://x.test/p');
    assert.strictEqual(
      out,
      'John Doe | <a href="https://x.test/p">SR Profile</a><br>No keyword tagged - Keywords match 0/4'
    );
  });
  it('escapes HTML-special characters in the name, keywords and location', () => {
    const out = formatNoteHtml(['C<b>'], 1, 1, '', 'A & B <x>', 'https://x.test/q', false, 'R&D <City>');
    assert.strictEqual(
      out,
      'A &amp; B &lt;x&gt; | <a href="https://x.test/q">SR Profile</a>' +
      '<br>Location: R&amp;D &lt;City&gt;<br><br>Keywords match 1/1:<br><br>C&lt;b&gt;'
    );
  });
  it('appends the partial-scan warning (HTML, escaped) when set', () => {
    const out = formatNoteHtml(['phd'], 1, 5, '', 'Jane', 'https://x.test/a', true);
    assert.ok(out.includes('<br>⚠ Resume PDF not read'));
    assert.ok(out.includes('Keywords match 1/5:<br><br>PhD'));
  });
});

describe('collapseInlineRepeats — Ctrl+F-accurate counts on duplicated PDF text', () => {
  it('collapses an immediately-repeated phrase to one', () => {
    assert.strictEqual(
      collapseInlineRepeats('Azure Azure Azure done').replace(/\s+/g, ' ').trim(),
      'Azure done'
    );
  });

  it('collapses spacing variants pdf.js emits (AI Fundamentals vs AIFundamentals)', () => {
    const out = collapseInlineRepeats('Azure AI Fundamentals AzureAIFundamentals Azure AI Fundamentals tail')
      .replace(/\s+/g, ' ').trim();
    assert.strictEqual(out, 'Azure AI Fundamentals tail');
  });

  it('preserves genuine non-consecutive repeats', () => {
    assert.strictEqual(
      collapseInlineRepeats('azure here and azure there').replace(/\s+/g, ' ').trim(),
      'azure here and azure there'
    );
  });

  it('keeps camelCase intact so downstream token splitting still works', () => {
    // survivor text is original-case → buildTokenIndex can still split PyTorch
    const out = collapseInlineRepeats('built with PyTorch PyTorch PyTorch today');
    assert.ok(out.includes('PyTorch'));
    const idx = buildTokenIndex(out);
    assert.strictEqual(kwHitsInIndex('py torch', idx, false), 1);
  });

  it('is a no-op on short / empty input', () => {
    assert.strictEqual(collapseInlineRepeats(''), '');
    assert.strictEqual(collapseInlineRepeats('Python dev'), 'Python dev');
  });
});

describe('countsFromResume — de-inflates pdf.js text-layer duplication', () => {
  const meta = resolveKeywordsWithMeta('azure, pytorch, tensorflow, nlp, aws');

  it('counts a tripled text-layer blob the way a human reads it once', () => {
    const spans = [
      'Senior AI Engineer building NLP systems',
      'Microsoft Certified: Azure AI Fundamentals 2024',
      'Microsoft Certified: Azure Fundamentals 2024',
      'AWS Certified Cloud Practitioner 2024',
      'Python Libraries: HuggingFace, Tensorflow, Pytorch, spacy, NLTK',
      'Azure: Azure Directory, Virtual Machine, API Gateway, AWS Lambda',
      'Built NLP pipelines and deployed to production',
    ];
    const variant = (s) => s.replace(/Fundamentals/g, 'Fund amentals').replace(/HuggingFace/g, 'Hugging Face');
    const blob = spans.map((s) => `${s} ${s} ${variant(s)}`).join(' ');
    const counts = countsFromResume(blob, meta.keywords, meta.canonicalMap);
    assert.strictEqual(counts.azure, 4);       // 2 certs + 2 in skills line
    assert.strictEqual(counts.pytorch, 1);
    assert.strictEqual(counts.tensorflow, 1);
    assert.strictEqual(counts.nlp, 2);
    assert.strictEqual(counts.aws, 2);
  });

  it('does not suppress real counts in a clean (non-duplicated) resume', () => {
    const clean = `Skills: Python, PyTorch, TensorFlow, Azure, NLP, AWS.
Built NLP pipelines on Azure. Deployed models to Azure and AWS.
PhD in machine learning. Used PyTorch for research and NLP at scale.
${'pad '.repeat(120)}`;
    const counts = countsFromResume(clean, meta.keywords, meta.canonicalMap);
    assert.strictEqual(counts.azure, 3);
    assert.strictEqual(counts.aws, 2);
    assert.strictEqual(counts.nlp, 3);
    assert.ok(counts.pytorch >= 2);
  });
});

describe('note-save confirmation — feed-appearance signal', () => {
  it('marker is the normalised "match N/T" count', () => {
    assert.strictEqual(noteConfirmMarker(3, 13), 'match 3/13');
  });
  it('marker for zero hits is "match 0/T"', () => {
    assert.strictEqual(noteConfirmMarker(0, 5), 'match 0/5');
  });
  it('marker is found in every note format, including a prefixed FAIL line', () => {
    const list = formatNoteText(['nlp', 'keras'], 2, 5, 'Boolean: ', 'Jane', 'https://x', false, 'Pune');
    const fail = formatNoteText([], 0, 5, '[FAIL] ');
    assert.ok(list.toLowerCase().includes(noteConfirmMarker(2, 5)));
    assert.ok(fail.toLowerCase().includes(noteConfirmMarker(0, 5)));
  });

  // contenteditable (div) editor: live note text is in textContent of BOTH the
  // section and the compose input, so they cancel — this was the case that always
  // logged UNCONFIRMED because the div never clears.
  it('div editor: detects the note in the feed even though the compose box keeps its text', () => {
    const marker = noteConfirmMarker(2, 5);
    // <br>-separated lines run together in textContent
    const composeText = 'Jane | SR ProfileLocation: PuneKeywords match 2/5:NLPPyTorch';
    // BEFORE post: only the compose box holds the text → feed delta 0
    assert.strictEqual(feedDeltaCount(composeText, composeText, marker), 0);
    // AFTER post: feed now also renders the note, compose box still holds its copy → delta 1
    const sectionAfter = 'Jane — Location: Pune Keywords match 2/5: NLP PyTorch · 2m ago ' + composeText;
    assert.strictEqual(feedDeltaCount(sectionAfter, composeText, marker), 1);
  });

  // textarea editor: live value is in NEITHER textContent → no double count.
  it('textarea editor: detects feed note with empty textContent (value lives off-DOM)', () => {
    const marker = noteConfirmMarker(1, 3);
    // textarea.textContent is empty (its value is not reflected in textContent)
    assert.strictEqual(feedDeltaCount('', '', marker), 0);
    assert.strictEqual(feedDeltaCount('Jane — Keywords match 1/3: Azure · now', '', marker), 1);
  });

  it('does not false-confirm when nothing new rendered', () => {
    const marker = noteConfirmMarker(1, 2);
    assert.strictEqual(feedDeltaCount('unrelated feed content here', 'Keywords match 1/2: Kubernetes', marker), 0);
  });

  it('an older note with the same count is in the baseline, so only a new copy confirms', () => {
    const marker = noteConfirmMarker(1, 2);
    const before = 'Jane — Keywords match 1/2: Go · 3d ago';
    assert.strictEqual(feedDeltaCount(before, '', marker), 1);
    assert.strictEqual(feedDeltaCount('Jane — Keywords match 1/2: Go · now ' + before, '', marker), 2);
  });
});

describe('resumeWasRead — partial-scan honesty (resume PDF actually read?)', () => {
  it('true for substantial non-chrome resume text', () => {
    assert.strictEqual(resumeWasRead('Senior NLP engineer with PyTorch and Azure experience across teams', false), true);
  });
  it('false when the captured text is SR summary chrome', () => {
    assert.strictEqual(resumeWasRead('whatever long text here that is plenty long enough', true), false);
  });
  it('false when the resume failed to load (empty/sub-50 chars)', () => {
    assert.strictEqual(resumeWasRead('', false), false);
    assert.strictEqual(resumeWasRead('   short   ', false), false);
  });
});

describe('job country gate for salary in notes', () => {
  const { isEeaCountry, salaryAllowedForJobCountry, jobCountryFromFields } = require('../keyword-pipeline.js');
  it('reads "Job Country" (asterisk and spacing stripped), ahead of other country fields', () => {
    const rows = [
      { name: 'Company *', value: 'NIQ' },
      { name: 'Compensation Country', value: 'Germany' },
      { name: 'Job Country *', value: ' India ' },
    ];
    assert.equal(jobCountryFromFields(rows), 'India');
    assert.equal(jobCountryFromFields([{ name: 'Country', value: 'Spain' }]), 'Spain');
    assert.equal(jobCountryFromFields([{ name: 'Job Level', value: '' }]), '');
  });
  it('EU/EEA countries are recognised, case-insensitively', () => {
    for (const c of ['Germany', 'the netherlands', 'Czech Republic', 'Norway', 'IRELAND']) assert.ok(isEeaCountry(c), c);
    for (const c of ['India', 'United Kingdom', 'Switzerland', 'United States', 'Czech', '']) assert.ok(!isEeaCountry(c), c);
  });
  it('salary is allowed only for a known non-EU/EEA country', () => {
    assert.equal(salaryAllowedForJobCountry('India'), true);
    assert.equal(salaryAllowedForJobCountry('Poland'), false);
    assert.equal(salaryAllowedForJobCountry(''), false);
  });
});
