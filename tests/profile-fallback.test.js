const test = require('node:test');
const assert = require('node:assert/strict');
const { extractProfileFromZwiftRacingPage, extractProfileFromZwiftPower, extractProfileFromZwiftRacingApi, normalizeWeightToKg, preferAuthenticatedWeight } = require('../get-user-data.js');

test('extractProfileFromZwiftRacingPage parses rider fields from embedded JSON', () => {
  const html = `<!doctype html><html><body><script id="__NEXT_DATA__">{"props":{"pageProps":{"rider":{"riderId":1243137,"name":"Marissa Pav","height":173,"weight":64,"history":[{"ftp":242}]}}}}</script></body></html>`;

  const profile = extractProfileFromZwiftRacingPage(html, 1243137);

  assert.equal(profile.name, 'Marissa Pav');
  assert.equal(profile.height, 173);
  assert.equal(profile.weight, 64);
  assert.equal(profile.ftp, 242);
  assert.equal(profile.sprinter, null);
  assert.equal(profile.puncher, null);
  assert.equal(profile.climber, null);
});

test('extractProfileFromZwiftRacingPage parses phenotype percentile scores', () => {
  const html = `<!doctype html><html><body><script id="__NEXT_DATA__">{"props":{"pageProps":{"rider":{"riderId":12896,"name":"Mike Huang","phenotype":{"overall":{"scores":{"sprinter":98.6,"puncheur":97.7,"climber":67.4}}}}}}}</script></body></html>`;

  const profile = extractProfileFromZwiftRacingPage(html, 12896);

  assert.equal(profile.sprinter, 98.6);
  assert.equal(profile.puncher, 97.7);
  assert.equal(profile.climber, 67.4);
});

test('extractProfileFromZwiftPower parses athlete data from authenticated activity results', () => {
  const payload = {
    data: [{
      zwid: 12896,
      name: 'Michael Huang',
      ftp: '254',
      weight: ['83.0', 0],
      height: [173, 0]
    }]
  };

  const profile = extractProfileFromZwiftPower(payload, 12896);

  assert.equal(profile.name, 'Michael Huang');
  assert.equal(profile.weight, 83);
  assert.equal(profile.ftp, 254);
  assert.equal(profile.height, 173);
});

test('extractProfileFromZwiftRacingApi parses authenticated Velo and phenotype percentiles', () => {
  const payload = {
    data: {
      riderId: 12896,
      ratings: { live: 624.153737535652 },
      legacyRatings: { live: 1656.858393411751 },
      factors: {
        sprint: { percentile: 99.5 },
        punch: { percentile: 86.3 },
        climb: { percentile: 21.1 }
      }
    }
  };

  const profile = extractProfileFromZwiftRacingApi(payload, 12896);

  assert.equal(profile.velo1, 1657);
  assert.equal(profile.velo2, 624);
  assert.equal(profile.sprinter, 99.5);
  assert.equal(profile.puncher, 86.3);
  assert.equal(profile.climber, 21.1);
});

test('extractProfileFromZwiftPower ignores race-result rows with zero placeholders', () => {
  const payload = {
    data: [{
      zwid: 72878,
      name: 'Steve Schilling',
      ftp: '300',
      weight: [0, 0],
      height: [0, 0],
      position_in_cat: 34,
      time_gun: 3360.534,
      gap: 498.197
    }]
  };

  const profile = extractProfileFromZwiftPower(payload, 72878);

  assert.equal(profile, null);
});

test('normalizeWeightToKg converts grams to kilograms and keeps kilograms intact', () => {
  assert.equal(normalizeWeightToKg(64000), 64);
  assert.equal(normalizeWeightToKg(64), 64);
  assert.equal(normalizeWeightToKg(null), null);
});

test('preferAuthenticatedWeight prefers the authenticated ZwiftRacing value when a generic profile is off by a large margin', () => {
  assert.equal(preferAuthenticatedWeight(100, 86.6), 87);
  assert.equal(preferAuthenticatedWeight(83, null), 83);
  assert.equal(preferAuthenticatedWeight(null, 86.6), 87);
});
