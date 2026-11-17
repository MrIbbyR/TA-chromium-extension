'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveKeywords,
  resolveKeywordsWithMeta,
  expandKeywords,
  applyTypoAliases,
  parseKeywordsFromString,
  canonicalizeKeywords,
} = require('../keyword-expansions.js');

describe('parseKeywordsFromString', () => {
  it('splits on commas', () => {
    assert.deepEqual(parseKeywordsFromString('Python, Java, R'), ['Python', 'Java', 'R']);
  });

  it('splits on semicolons', () => {
    assert.deepEqual(parseKeywordsFromString('Python; Java'), ['Python', 'Java']);
  });

  it('splits on newlines', () => {
    assert.deepEqual(parseKeywordsFromString('Python\nJava'), ['Python', 'Java']);
  });

  it('skips lines starting with #', () => {
    const result = parseKeywordsFromString('Python\n# comment\nJava');
    assert.ok(!result.includes('# comment'));
    assert.deepEqual(result, ['Python', 'Java']);
  });

  it('empty string returns empty array', () => {
    assert.deepEqual(parseKeywordsFromString(''), []);
  });

  it('trims whitespace from each keyword', () => {
    assert.deepEqual(parseKeywordsFromString('  Python  ,  Java  '), ['Python', 'Java']);
  });
});

describe('canonicalizeKeywords', () => {
  it('removes case-duplicates, keeping first occurrence', () => {
    assert.deepEqual(canonicalizeKeywords(['Python', 'python', 'PYTHON']), ['Python']);
  });

  it('removes blank entries', () => {
    assert.deepEqual(canonicalizeKeywords(['Python', '', '  ']), ['Python']);
  });

  it('preserves order of first occurrence', () => {
    assert.deepEqual(canonicalizeKeywords(['Java', 'Python', 'java']), ['Java', 'Python']);
  });
});

describe('applyTypoAliases', () => {
  it('fixes known typos', () => {
    assert.deepEqual(applyTypoAliases(['pytroch']), ['pytorch']);
    assert.deepEqual(applyTypoAliases(['tensorlfow']), ['tensorflow']);
    assert.deepEqual(applyTypoAliases(['azuer']), ['azure']);
  });

  it('leaves correct spellings unchanged', () => {
    assert.deepEqual(applyTypoAliases(['pytorch', 'tensorflow']), ['pytorch', 'tensorflow']);
  });

  it('handles mixed array', () => {
    const result = applyTypoAliases(['pytroch', 'Python']);
    assert.strictEqual(result[0], 'pytorch');
    assert.strictEqual(result[1], 'Python');
  });
});

describe('expandKeywords — bidirectional expansion', () => {
  it('ml → includes "machine learning"', () => {
    const expanded = expandKeywords(['ml']);
    assert.ok(expanded.some(k => k.toLowerCase() === 'machine learning'));
  });

  it('"machine learning" → includes "ml"', () => {
    const expanded = expandKeywords(['machine learning']);
    assert.ok(expanded.some(k => k.toLowerCase() === 'ml'));
  });

  it('pytorch → includes "torch"', () => {
    const expanded = expandKeywords(['pytorch']);
    assert.ok(expanded.some(k => k.toLowerCase() === 'torch'));
  });

  it('k8s → includes "kubernetes"', () => {
    const expanded = expandKeywords(['k8s']);
    assert.ok(expanded.some(k => k.toLowerCase() === 'kubernetes'));
  });

  it('no duplicate forms after expansion', () => {
    const expanded = expandKeywords(['ml', 'machine learning']);
    const lower = expanded.map(k => k.toLowerCase());
    const unique = [...new Set(lower)];
    assert.strictEqual(lower.length, unique.length);
  });
});

describe('resolveKeywords — full pipeline', () => {
  it('typo-fixes, expands, and deduplicates', () => {
    const result = resolveKeywords('pytroch');
    // pytroch → pytorch → expanded to include torch, py torch, etc.
    assert.ok(result.some(k => k.toLowerCase() === 'pytorch'));
    assert.ok(result.some(k => k.toLowerCase() === 'torch'));
  });

  it('comma-separated input', () => {
    const result = resolveKeywords('ml, dl');
    assert.ok(result.some(k => k.toLowerCase() === 'ml'));
    assert.ok(result.some(k => k.toLowerCase() === 'machine learning'));
    assert.ok(result.some(k => k.toLowerCase() === 'deep learning'));
  });

  it('no duplicates in output', () => {
    const result = resolveKeywords('ml, machine learning');
    const lower = result.map(k => k.toLowerCase());
    const unique = [...new Set(lower)];
    assert.strictEqual(lower.length, unique.length);
  });

  it('empty input returns empty array', () => {
    assert.deepEqual(resolveKeywords(''), []);
  });
});

describe('resolveKeywordsWithMeta', () => {
  it('returns keywords array identical to resolveKeywords', () => {
    const { keywords } = resolveKeywordsWithMeta('pytorch, tensorflow');
    const plain = resolveKeywords('pytorch, tensorflow');
    assert.deepEqual(keywords, plain);
  });

  it('user-typed keyword maps to itself in canonicalMap', () => {
    const { canonicalMap } = resolveKeywordsWithMeta('pytorch, tensorflow');
    assert.strictEqual(canonicalMap['pytorch'], 'pytorch');
    assert.strictEqual(canonicalMap['tensorflow'], 'tensorflow');
  });

  it('expansion forms map back to the user-typed canonical', () => {
    const { keywords, canonicalMap } = resolveKeywordsWithMeta('tensorflow');
    assert.strictEqual(canonicalMap['tensor flow'], 'tensorflow');
    const { findKeywordHits, deduplicateHitsByCanonical } = require('../keyword-matching.js');
    const hits = deduplicateHitsByCanonical(findKeywordHits('Built models in Tensor-Flow', keywords).hits, canonicalMap);
    assert.deepStrictEqual(hits.map(h => h.keyword), ['tensorflow']);
  });

  it('when user types both canonical and an alias, each maps to itself', () => {
    // User explicitly types "tensorflow" AND "tensor flow" — both are canonical
    const { canonicalMap } = resolveKeywordsWithMeta('tensorflow, tensor flow');
    assert.strictEqual(canonicalMap['tensorflow'], 'tensorflow');
    assert.strictEqual(canonicalMap['tensor flow'], 'tensor flow');
  });

  it('userCount equals the number of keywords before expansion', () => {
    const { userCount, keywords } = resolveKeywordsWithMeta('pytorch, tensorflow, sklearn');
    assert.strictEqual(userCount, 3);
    assert.ok(keywords.length > 3); // expanded list must be larger
  });

  it('typo is corrected before building canonicalMap', () => {
    const { canonicalMap } = resolveKeywordsWithMeta('pytroch'); // typo → pytorch
    assert.strictEqual(canonicalMap['pytorch'], 'pytorch');
    // expansion of pytorch is also mapped back
    assert.ok(canonicalMap['py torch'] === 'pytorch' || canonicalMap['torch'] === 'pytorch');
  });

  it('empty input returns empty keywords and empty map', () => {
    const { keywords, canonicalMap, userCount } = resolveKeywordsWithMeta('');
    assert.deepEqual(keywords, []);
    assert.strictEqual(Object.keys(canonicalMap).length, 0);
    assert.strictEqual(userCount, 0);
  });
});

describe('synonym groups — every way a CV writes a skill, in both search modes', () => {
  const { KEYWORD_SYNONYM_GROUPS, buildExpansionTable } = require('../keyword-expansions.js');
  const { expandOneBooleanTerm, findKeywordHits } = require('../keyword-matching.js');
  const found = (cv, forms) => findKeywordHits(cv, forms, { scanEveryKeyword: true }).hits.length > 0;

  it('every form of a group finds every other form (keyword and boolean)', () => {
    for (const group of KEYWORD_SYNONYM_GROUPS) {
      for (const typed of group) {
        const kw = resolveKeywords(typed);
        const bool = expandOneBooleanTerm(typed);
        for (const cv of group) {
          assert.ok(found(`Experience: ${cv}.`, kw), `keyword "${typed}" should find "${cv}"`);
          assert.ok(found(`Experience: ${cv}.`, bool), `boolean "${typed}" should find "${cv}"`);
        }
      }
    }
  });

  it('no form is in two groups', () => {
    const seen = new Map();
    KEYWORD_SYNONYM_GROUPS.forEach((group, gi) => group.forEach(f => {
      assert.ok(!seen.has(f), `"${f}" is in groups ${seen.get(f)} and ${gi}`);
      seen.set(f, gi);
    }));
  });

  const cases = {
    aws: ['AWS', 'Amazon Web Services', 'Amazon-Web-Services', 'Amazon Cloud Services', 'AWS Cloud'],
    gcp: ['GCP', 'Google Cloud Platform', 'Google Cloud', 'GoogleCloud', 'gcloud'],
    azure: ['Azure', 'Microsoft Azure', 'MS Azure', 'Windows Azure'],
    pytorch: ['PyTorch', 'Py-Torch', 'Py Torch', 'py_torch'],
    kubernetes: ['Kubernetes', 'K8s'],
  };
  for (const [search, cvs] of Object.entries(cases)) {
    it(`"${search}" finds ${cvs.join(', ')}`, () => {
      for (const cv of cvs) {
        assert.ok(found(`Skills: ${cv}`, resolveKeywords(search)), `keyword: ${cv}`);
        assert.ok(found(`Skills: ${cv}`, expandOneBooleanTerm(search)), `boolean: ${cv}`);
      }
    });
  }

  it('the search can be typed with any spacing or hyphens', () => {
    for (const typed of ['Single Sign On', 'single-sign-on', 'Amazon-Web-Services', 'Google Cloud-Platform']) {
      assert.ok(expandOneBooleanTerm(typed).length > 1, `boolean "${typed}" expands`);
      assert.ok(resolveKeywords(typed).length > 1, `keyword "${typed}" expands`);
    }
  });

  it('one-way extras stay one-way (Docker finds "container", not the reverse)', () => {
    const t = buildExpansionTable();
    assert.ok(t.docker.includes('container'));
    assert.ok(!(t.container || []).includes('docker'));
    assert.ok(!(t['computer vision'] || []).includes('cv'), 'every CV says "CV"');
  });
});
