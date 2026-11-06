const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { Readable } = require('node:stream');
const { fetchOneRider } = require('../get_data2.js');

test('fetchOneRider requests the gender compare percentiles and keeps the compare-values phenotype mapping', async () => {
  const originalGet = https.get;
  const requestedUrls = [];

  https.get = (url, options, callback) => {
    const targetUrl = typeof url === 'string' ? url : url?.href || '';
    requestedUrls.push(targetUrl);

    let body = '';
    if (targetUrl === 'https://www.zwiftracing.app/riders/5625938') {
      body = '<!doctype html><html><body><script id="__NEXT_DATA__">{"props":{"pageProps":{"rider":{"riderId":5625938,"name":"John Daly","weight":105,"height":198,"ratings":{"live":670},"legacyRatings":{"live":1624}}}}}</script></body></html>';
    } else if (targetUrl === 'https://www.zwiftracing.app/riders/5625938/velo?compare=gender') {
      body = '<!doctype html><html><body><script id="__NEXT_DATA__">{"props":{"pageProps":{"rider":{"riderId":5625938,"name":"John Daly","weight":105,"height":198,"points":{"sprint":{"percentile":90},"climb":{"percentile":74}}}}}}</script></body></html>';
    } else if (targetUrl === 'https://www.zwiftracing.app/riders/5625938/power') {
      body = '<!doctype html><html><body><script id="__NEXT_DATA__">{"props":{"pageProps":{"rider":{"riderId":5625938,"power":{"curve":[{"durationSec":15,"d90":{"w":1279,"wkg":12.16}},{"durationSec":300,"d90":{"w":441,"wkg":4.19}}]}}}}}</script></body></html>';
    } else if (targetUrl === 'https://api.zwiftracing.app/api/v2/riders/5625938') {
      body = JSON.stringify({ success: true, data: { riderId: 5625938, name: 'John Daly', weight: 105, height: 198, ratings: { live: 670 }, legacyRatings: { live: 1624 } } });
    } else if (targetUrl === 'https://api.zwiftracing.app/api/v2/riders/5625938/power') {
      body = JSON.stringify({ success: true, data: { curve: [
        { durationSec: 15, d90: { w: 1279, wkg: 12.16 } },
        { durationSec: 300, d90: { w: 441, wkg: 4.19 } }
      ] } });
    } else if (targetUrl === 'https://api.zwiftracing.app/api/v2/riders/5625938/power/percentiles?age=all&band=all') {
      body = JSON.stringify({ success: true, data: {
        factors: {
          sprint: { value: 967, percentile: 98.1 },
          punch: { value: 808.38, percentile: 91.6 },
          climb: { value: 584.5, percentile: 1.4 }
        }
      } });
    }

    const stream = Readable.from([body]);
    const callbackWithStream = callback || (() => {});
    callbackWithStream(stream);
    return { on: () => {}, end: () => {} };
  };

  try {
    const row = await fetchOneRider(5625938);

    assert.ok(requestedUrls.some((url) => url.includes('/power/percentiles?age=all&band=all')),
      `Expected gender compare percentiles request, got: ${requestedUrls.join('\n')}`);
    assert.equal(row.sprinter, 98.1);
    assert.equal(row.puncher, 91.6);
    assert.equal(row.climber, 1.4);
  } finally {
    https.get = originalGet;
  }
});
