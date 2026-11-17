'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseBooleanQuery, evaluateBooleanAst, extractLeafTerms } = require('../keyword-triage-core.js');

// ── AST shape helpers ──
function term(v, opts = {}) { return { type: 'TERM', value: v, ...opts }; }
function and(l, r)           { return { type: 'AND', left: l, right: r }; }
function or(l, r)            { return { type: 'OR', left: l, right: r }; }
function not(o)              { return { type: 'NOT', operand: o }; }

describe('parseBooleanQuery — AST structure', () => {
  it('single term', () => {
    assert.deepEqual(parseBooleanQuery('Python'), term('Python'));
  });

  it('AND of two terms', () => {
    assert.deepEqual(parseBooleanQuery('Python AND Java'), and(term('Python'), term('Java')));
  });

  it('OR of two terms', () => {
    assert.deepEqual(parseBooleanQuery('Python OR Java'), or(term('Python'), term('Java')));
  });

  it('NOT of a term', () => {
    assert.deepEqual(parseBooleanQuery('NOT intern'), not(term('intern')));
  });

  it('AND binds tighter than OR — A OR B AND C ≡ A OR (B AND C)', () => {
    const ast = parseBooleanQuery('Python OR Java AND TensorFlow');
    assert.strictEqual(ast.type, 'OR');
    assert.strictEqual(ast.left.value, 'Python');
    assert.strictEqual(ast.right.type, 'AND');
    assert.strictEqual(ast.right.left.value, 'Java');
    assert.strictEqual(ast.right.right.value, 'TensorFlow');
  });

  it('NOT binds tighter than AND — A AND NOT B', () => {
    const ast = parseBooleanQuery('Python AND NOT intern');
    assert.strictEqual(ast.type, 'AND');
    assert.strictEqual(ast.left.value, 'Python');
    assert.strictEqual(ast.right.type, 'NOT');
    assert.strictEqual(ast.right.operand.value, 'intern');
  });

  it('explicit parentheses override default precedence', () => {
    const ast = parseBooleanQuery('(Python OR Java) AND TensorFlow');
    assert.strictEqual(ast.type, 'AND');
    assert.strictEqual(ast.left.type, 'OR');
    assert.strictEqual(ast.right.value, 'TensorFlow');
  });

  it('quoted phrase becomes a single TERM node', () => {
    const ast = parseBooleanQuery('"machine learning"');
    assert.strictEqual(ast.type, 'TERM');
    assert.strictEqual(ast.value, 'machine learning');
    assert.strictEqual(ast.quoted, true);
  });

  it('smart quotes treated as regular quotes', () => {
    const ast = parseBooleanQuery('“deep learning”');
    assert.strictEqual(ast.type, 'TERM');
    assert.strictEqual(ast.value, 'deep learning');
  });

  it('implicit AND between adjacent terms', () => {
    const ast = parseBooleanQuery('Python Java');
    assert.strictEqual(ast.type, 'AND');
    assert.strictEqual(ast.left.value, 'Python');
    assert.strictEqual(ast.right.value, 'Java');
  });

  it('empty input returns empty TERM', () => {
    const ast = parseBooleanQuery('');
    assert.strictEqual(ast.type, 'TERM');
    assert.strictEqual(ast.value, '');
  });
});

describe('evaluateBooleanAst', () => {
  it('single matched term → true', () => {
    assert.strictEqual(evaluateBooleanAst(term('Python'), { python: true }), true);
  });

  it('single unmatched term → false', () => {
    assert.strictEqual(evaluateBooleanAst(term('Python'), {}), false);
  });

  it('AND — both present → true', () => {
    assert.strictEqual(evaluateBooleanAst(and(term('Python'), term('Java')), { python: true, java: true }), true);
  });

  it('AND — one missing → false', () => {
    assert.strictEqual(evaluateBooleanAst(and(term('Python'), term('Java')), { python: true }), false);
  });

  it('OR — one present → true', () => {
    assert.strictEqual(evaluateBooleanAst(or(term('Python'), term('Java')), { java: true }), true);
  });

  it('OR — none present → false', () => {
    assert.strictEqual(evaluateBooleanAst(or(term('Python'), term('Java')), {}), false);
  });

  it('NOT — term present → false', () => {
    assert.strictEqual(evaluateBooleanAst(not(term('intern')), { intern: true }), false);
  });

  it('NOT — term absent → true', () => {
    assert.strictEqual(evaluateBooleanAst(not(term('intern')), {}), true);
  });

  it('complex: (Python OR Java) AND NOT intern — pass', () => {
    const ast = parseBooleanQuery('(Python OR Java) AND NOT intern');
    assert.strictEqual(evaluateBooleanAst(ast, { python: true }), true);
  });

  it('complex: (Python OR Java) AND NOT intern — fail when intern present', () => {
    const ast = parseBooleanQuery('(Python OR Java) AND NOT intern');
    assert.strictEqual(evaluateBooleanAst(ast, { python: true, intern: true }), false);
  });

  it('complex: (Python OR Java) AND NOT intern — fail when neither Python nor Java', () => {
    const ast = parseBooleanQuery('(Python OR Java) AND NOT intern');
    assert.strictEqual(evaluateBooleanAst(ast, {}), false);
  });

  it('term lookup is case-insensitive via lowercase key', () => {
    // evaluateBooleanAst lowercases the term value before looking up in matchedSet
    assert.strictEqual(evaluateBooleanAst(term('TensorFlow'), { tensorflow: true }), true);
  });
});

describe('extractLeafTerms', () => {
  it('positive terms have negated=false', () => {
    const leaves = extractLeafTerms(parseBooleanQuery('Python AND Java'));
    assert.ok(leaves.every(l => l.negated === false));
    assert.deepEqual(leaves.map(l => l.value), ['Python', 'Java']);
  });

  it('NOT terms have negated=true', () => {
    const leaves = extractLeafTerms(parseBooleanQuery('Python AND NOT intern'));
    const neg = leaves.find(l => l.value === 'intern');
    assert.ok(neg && neg.negated === true);
    const pos = leaves.find(l => l.value === 'Python');
    assert.ok(pos && pos.negated === false);
  });
});

describe('boolean synonyms — "aws" finds how a CV might write it', () => {
  const {
    booleanCanonicalMap, expandOneBooleanTerm, findKeywordHits, deduplicateHitsByCanonical,
  } = require('../keyword-matching.js');

  // Mirrors runBooleanTriageWithDoc: scan every form, fold hits to the typed term.
  function runBoolean(query, text) {
    const ast = parseBooleanQuery(query);
    const terms = [...new Set(extractLeafTerms(ast).map(l => l.value))];
    const map = booleanCanonicalMap(terms);
    const scans = [...new Set(terms.flatMap(t => expandOneBooleanTerm(t)))];
    const hits = findKeywordHits(text, scans, { maxItems: 15000, scanEveryKeyword: true }).hits;
    const matched = {};
    for (const h of hits) matched[map[h.keyword.toLowerCase()].toLowerCase()] = true;
    return { pass: evaluateBooleanAst(ast, matched), hits: deduplicateHitsByCanonical(hits, map) };
  }

  for (const cv of ['Amazon Web Services', 'AWS', 'Amazon Cloud Services', 'amazon web service', 'AWS Cloud']) {
    it(`"aws AND python" passes on a CV that says "${cv}"`, () => {
      const r = runBoolean('aws AND python', `Built data pipelines in Python on ${cv} (EC2, S3).`);
      assert.strictEqual(r.pass, true);
      assert.deepStrictEqual(r.hits.map(h => h.keyword).sort(), ['aws', 'python']);
    });
  }

  it('both spellings on one CV give one note line under the typed term', () => {
    const r = runBoolean('aws', 'AWS certified. 5 years on Amazon Web Services. AWS Lambda.');
    assert.deepStrictEqual(r.hits.map(h => h.keyword), ['aws']);
  });

  it('the typed spelling is kept, whichever form the CV uses', () => {
    const r = runBoolean('"Amazon Web Services"', 'Deployed on AWS.');
    assert.deepStrictEqual(r.hits.map(h => h.keyword), ['Amazon Web Services']);
  });

  it('two typed synonyms stay separate terms', () => {
    const map = booleanCanonicalMap(['aws', 'amazon web services']);
    assert.strictEqual(map['aws'], 'aws');
    assert.strictEqual(map['amazon web services'], 'amazon web services');
  });

  it('NOT aws excludes a CV that only says Amazon Web Services', () => {
    assert.strictEqual(runBoolean('python AND NOT aws', 'Python on Amazon Web Services').pass, false);
  });
});
