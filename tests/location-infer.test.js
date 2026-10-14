'use strict';
// Candidate location for the keyword note: profile field → resume → phone.
// Resume samples include the five from ATS-market-reporter/ner_location.py.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeLocationString,
  normalizeDomLocation,
  domCityOnly,
  inferLocationFromResume,
  resolveCandidateLocation,
  formatLocationLabel,
  countryFromPhone,
} = require('../location-infer.js');

const label = (input) => formatLocationLabel(resolveCandidateLocation(input));

describe('normalizeDomLocation — the SR profile location slot', () => {
  it('keeps "City, Country", canonicalising the country', () => {
    assert.strictEqual(normalizeDomLocation('Chennai, India'), 'Chennai, India');
    assert.strictEqual(normalizeDomLocation('London, UK'), 'London, United Kingdom');
  });
  it('treats an Indian state as implying India', () => {
    assert.strictEqual(normalizeDomLocation('Pune, Maharashtra'), 'Pune, Maharashtra, India');
  });
  it('rejects the phone number or email that share the row', () => {
    assert.strictEqual(normalizeDomLocation('+91 98765 43210'), '');
    assert.strictEqual(normalizeDomLocation('jane@example.com'), '');
  });
  it('rejects a job line that happens to end in a country', () => {
    assert.strictEqual(normalizeDomLocation('Engineer at Acme, India'), '');
    assert.strictEqual(normalizeDomLocation('RESEARCH SCHOLAR at Department of Mechatronics, RPTU'), '');
  });
  it('needs a country or state last', () => {
    assert.strictEqual(normalizeDomLocation('Chennai'), '');
  });
});

describe('domCityOnly — a bare city in the slot', () => {
  it('finds a gazetteer city', () => {
    assert.strictEqual(domCityOnly(['Chennai']), 'Chennai');
    assert.strictEqual(domCityOnly(['Bangalore']), 'Bengaluru');
  });
  it('ignores non-places, tech words and common words that are also city names', () => {
    assert.strictEqual(domCityOnly(['+91 98765 43210', 'Docker', 'Mobile']), '');
  });
});

describe('normalizeLocationString', () => {
  it('drops house numbers and PIN codes and finds the city', () => {
    assert.strictEqual(
      normalizeLocationString('12, MG Road, Kharadi, Pune, Maharashtra 411014'),
      'Pune, Maharashtra, India'
    );
  });
  it('finds a city at the end of a phrase ("based in Pune")', () => {
    assert.strictEqual(normalizeLocationString('Currently based in Pune, India'), 'Pune, India');
  });
  it('gives "Region, Country" when no city is named', () => {
    assert.strictEqual(normalizeLocationString('West Bengal, India'), 'West Bengal, India');
  });
  it('requires the city to be in the stated country', () => {
    assert.strictEqual(normalizeLocationString('Hyderabad, Pakistan'), 'Hyderabad, Pakistan');
    assert.strictEqual(normalizeLocationString('Chennai, Germany'), '');
  });
  it('maps old city names to the current ones', () => {
    assert.strictEqual(normalizeLocationString('Gurgaon, Haryana, India'), 'Gurugram, Haryana, India');
  });
});

describe('inferLocationFromResume — ner_location.py samples', () => {
  const cases = [
    ['City, State, Country line',
      'John Smith\nSoftware Engineer\nMumbai, Maharashtra, India\nEmail: john@example.com\nPhone: +91-9876543210',
      'Mumbai, Maharashtra, India'],
    ['"Location:" label',
      'RAMESH KUMAR\nSenior QA Engineer\nLocation: Chennai, Tamil Nadu, India\nramesh.kumar@email.com | +91-9988776655',
      'Chennai, Tamil Nadu, India'],
    ['sparse text, no comma', 'Bangalore India\nPython Developer\n5 years experience', 'Bengaluru, India'],
    ['City, Country above EXPERIENCE',
      'PRIYA SHARMA\nData Analyst\nPune, India\n\nEXPERIENCE\nData Analyst at Tech Corp', 'Pune, India'],
    ['state only', 'VIJAY RAO\nWest Bengal, India\nFull Stack Developer', 'West Bengal, India'],
  ];
  for (const [name, text, want] of cases) {
    it(name, () => {
      const r = inferLocationFromResume(text);
      assert.ok(r, 'expected a location');
      assert.strictEqual(r.location, want);
    });
  }
  it('reads a "Location" heading with the value on the next line', () => {
    assert.strictEqual(inferLocationFromResume('Asha\nLocation\nNoida, Uttar Pradesh, India').location,
      'Noida, Uttar Pradesh, India');
  });
  it('does not take a city from the skills line or ordinary words', () => {
    assert.strictEqual(inferLocationFromResume('Engineer\nSkills: Python, Docker, AWS\nworked on mobile apps in a reading group'), null);
  });
  it('returns null for empty text', () => {
    assert.strictEqual(inferLocationFromResume(''), null);
  });
});

describe('countryFromPhone', () => {
  it('maps the calling code', () => {
    assert.strictEqual(countryFromPhone('+91 98765 43210'), 'India');
    assert.strictEqual(countryFromPhone('+44 7700 900123'), 'United Kingdom');
    assert.strictEqual(countryFromPhone('+971 50 123 4567'), 'United Arab Emirates');
  });
  it('needs a + prefix', () => {
    assert.strictEqual(countryFromPhone('98765 43210'), '');
  });
});

describe('resolveCandidateLocation + formatLocationLabel — what the note shows', () => {
  const resume = 'PRIYA SHARMA\nData Analyst\nPune, India\n\nEXPERIENCE\nAnalyst, Mumbai';
  it('profile field wins and is marked (verified)', () => {
    assert.strictEqual(label({ slotTexts: ['Chennai, India'], resumeText: resume }), 'Chennai, India (verified)');
  });
  it('a bare profile city is still (verified)', () => {
    assert.strictEqual(label({ slotTexts: ['Chennai'], resumeText: resume }), 'Chennai (verified)');
  });
  it('falls back to the resume, marked (from resume), when the slot holds a phone', () => {
    assert.strictEqual(
      label({ slotTexts: ['+91 98765 43210'], otherTexts: ['Engineer at Acme, India'], resumeText: resume }),
      'Pune, India (from resume)'
    );
  });
  it('falls back to the phone country, marked (from phone)', () => {
    assert.strictEqual(label({ phone: '+91 98765 43210', resumeText: 'Raj\nEXPERIENCE\nInfosys, Mysore' }), 'India (from phone)');
    assert.strictEqual(label({ resumeText: 'Jane | +44 7700 900123\nEXPERIENCE\nAcme, London' }), 'United Kingdom (from phone)');
  });
  it('is empty when nothing is known', () => {
    assert.strictEqual(label({}), '');
    assert.strictEqual(resolveCandidateLocation({ slotTexts: ['Docker'] }), null);
  });
});
