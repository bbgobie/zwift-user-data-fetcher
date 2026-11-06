const test = require('node:test');
const assert = require('node:assert/strict');
const { extractProfileFromZwiftRacingPage, extractProfileFromZwiftPower, extractProfileFromZwiftRacingApi, normalizeWeightToKg, preferAuthenticatedWeight, extractPowerFromEfforts } = require('../get-user-data.js');

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

test('extractProfileFromZwiftRacingPage prefers Men/gender compare scores when present', () => {
  const html = `<!doctype html><html><body><script id="__NEXT_DATA__">{"props":{"pageProps":{"rider":{"riderId":5625938,"name":"John Daly","phenotype":{"overall":{"compare":{"gender":{"scores":{"sprinter":86.1,"puncheur":81.4,"climber":68.3}}},"scores":{"sprinter":98.7,"puncheur":97.1,"climber":87.9}}}}}}}</script></body></html>`;

  const profile = extractProfileFromZwiftRacingPage(html, 5625938);

  assert.equal(profile.sprinter, 86.1);
  assert.equal(profile.puncher, 81.4);
  assert.equal(profile.climber, 68.3);
});

test('extractProfileFromZwiftRacingApi prefers compare=gender score objects before category scores', () => {
  const payload = {
    data: {
      riderId: 5625938,
      name: 'John Daly',
      phenotype: {
        overall: {
          scores: { sprinter: 91.7, puncheur: 86.4, climber: 72.9 },
          compare: { gender: { scores: { sprinter: 84.2, puncheur: 79.6, climber: 65.1 } } }
        }
      }
    }
  };

  const profile = extractProfileFromZwiftRacingApi(payload, 5625938);

  assert.equal(profile.sprinter, 84.2);
  assert.equal(profile.puncher, 79.6);
  assert.equal(profile.climber, 65.1);
});

test('extractPowerFromZwiftRacingPower reads the 90-day power table from ZwiftRacing payloads', () => {
  const payload = {
    data: {
      power: {
        '15s': { watts: 930, wkg: 12.1 },
        '30s': { watts: 760, wkg: 9.9 },
        '1min': { watts: 610, wkg: 7.9 },
        '2min': { watts: 500, wkg: 6.5 },
        '5min': { watts: 380, wkg: 4.9 },
        '20min': { watts: 320, wkg: 4.2 }
      }
    }
  };

  const powerData = extractPowerFromZwiftRacingPower(payload, 77);

  assert.equal(powerData['15s_watts'], 930);
  assert.equal(powerData['15s_wkg'], 12.1);
  assert.equal(powerData['1min_watts'], 610);
  assert.equal(powerData['20min_watts'], 320);
  assert.equal(powerData['20min_wkg'], 4.2);
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

test('extractProfileFromZwiftRacingApi reads phenotype percentiles from the live nested Velo factor shape', () => {
  const payload = {
    data: {
      riderId: 1243137,
      ratings: { live: 680 },
      legacyRatings: { live: 680 },
      velo: {
        factors: {
          sprint: { percentile: 82.4 },
          punch: { percentile: 71.3 },
          climb: { percentile: 55.7 }
        }
      },
      seed: {
        factors: {
          sprint: { percentile: 82.4 },
          punch: { percentile: 71.3 },
          climb: { percentile: 55.7 }
        }
      }
    }
  };

  const profile = extractProfileFromZwiftRacingApi(payload, 1243137);

  assert.equal(profile.sprinter, 82.4);
  assert.equal(profile.puncher, 71.3);
  assert.equal(profile.climber, 55.7);
});

test('extractProfileFromZwiftRacingApi reads live rider percentile values from the points payload', () => {
  const payload = {
    data: {
      riderId: 1243137,
      name: 'Marissa Pav',
      phenotype: { version: 4, label: 'allRounder', confidence: 0.904 },
      points: {
        gc: { percentile: 74.3 },
        sprint: { percentile: 76.9 },
        climb: { percentile: 30.9 },
        tt: null,
        updatedAt: 1793246741
      },
      velo: {
        factors: {
          sprint: 759.25,
          punch: 733.18,
          climb: 701
        }
      }
    }
  };

  const profile = extractProfileFromZwiftRacingApi(payload, 1243137);

  assert.equal(profile.sprinter, 76.9);
  assert.equal(profile.climber, 30.9);
  assert.equal(profile.puncher, null);
});

test('extractProfileFromZwiftPower keeps FTP from race-result rows while ignoring zero placeholder weight/height', () => {
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

  assert.equal(profile.name, 'Steve Schilling');
  assert.equal(profile.ftp, 300);
  assert.equal(profile.weight, null);
  assert.equal(profile.height, null);
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

test('extractPowerFromEfforts falls back to current weight when no explicit W/kg is provided', () => {
  const efforts = [
    { x: 15, y: 928 },
    { x: 30, y: 749 },
    { x: 60, y: 607 },
    { x: 120, y: 492 },
    { x: 300, y: 375 },
    { x: 1200, y: 318 }
  ];

  const powerData = extractPowerFromEfforts(efforts, 77);

  assert.equal(powerData['15s_wkg'], 12.05);
  assert.equal(powerData['30s_wkg'], 9.73);
  assert.equal(powerData['1min_wkg'], 7.88);
  assert.equal(powerData['5min_wkg'], 4.87);
  assert.equal(powerData['20min_wkg'], 4.13);
  assert.equal(powerData['15s_watts'], 928);
  assert.equal(powerData['1min_watts'], 607);
  assert.equal(powerData['20min_watts'], 318);
});
