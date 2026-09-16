const test = require('node:test');
const assert = require('node:assert/strict');
const { extractProfileFromZwiftRacingPage, normalizeWeightToKg } = require('../get-user-data.js');

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

test('normalizeWeightToKg converts grams to kilograms and keeps kilograms intact', () => {
  assert.equal(normalizeWeightToKg(64000), 64);
  assert.equal(normalizeWeightToKg(64), 64);
  assert.equal(normalizeWeightToKg(null), null);
});
