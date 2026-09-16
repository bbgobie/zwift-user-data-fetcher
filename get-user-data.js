const { ZwiftAPI, ZwiftPowerAPI } = require('@codingwithspike/zwift-api-wrapper');
const fs = require('fs');
const path = require('path');
const https = require('https');
let puppeteer = null;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  // puppeteer may not be installed yet; we'll handle at runtime
}
require('dotenv').config();

function normalizeZwiftPowerCookies(input) {
  if (!input || typeof input !== 'string') return null;

  const raw = input.trim();
  if (!raw) return null;

  const jarBase = {
    version: 'tough-cookie@3.0.0',
    storeType: 'MemoryCookieStore',
    rejectPublicSuffixes: false,
    cookies: []
  };

  const serializeJar = (cookies) => JSON.stringify({ ...jarBase, cookies });

  const parseCookiePairs = (value) => {
    const stripped = value.replace(/^Cookie:\s*/i, '').trim();
    return stripped
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(pair => {
        const idx = pair.indexOf('=');
        if (idx <= 0) return null;
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        return key && val !== undefined ? { key, value: val } : null;
      })
      .filter(Boolean);
  };

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return serializeJar(parsed.map((c, idx) => ({
        key: c.name || c.key,
        value: c.value || '',
        expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : 'Infinity',
        maxAge: null,
        domain: (c.domain || '').replace(/^\./, '') || 'zwiftpower.com',
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        extensions: null,
        creation: Date.now() + idx,
        creationIndex: idx + 1
      })));
    }
    if (parsed && parsed.cookies && Array.isArray(parsed.cookies)) {
      return raw;
    }
  } catch (e) {
    // fall through to string-based parsing
  }

  const cookiePairs = parseCookiePairs(raw);
  if (cookiePairs.length > 0) {
    return serializeJar(cookiePairs.map((c, idx) => ({
      key: c.key,
      value: c.value,
      expires: 'Infinity',
      maxAge: null,
      domain: 'zwiftpower.com',
      path: '/',
      secure: false,
      httpOnly: true,
      extensions: null,
      creation: Date.now() + idx,
      creationIndex: idx + 1
    })));
  }

  return serializeJar([{
    key: 'phpbb3_lswlk_sid',
    value: raw,
    expires: 'Infinity',
    maxAge: null,
    domain: 'zwiftpower.com',
    path: '/',
    secure: false,
    httpOnly: true,
    extensions: null,
    creation: Date.now(),
    creationIndex: 1
  }]);
}

// Best-effort fetch of zwiftracing.app category. Uses env `ZWIFTRACING_URL_TEMPLATE` where `{id}` is replaced.
function fetchJsonUrl(url) {
  return new Promise((resolve, reject) => {
    try {
      https.get(url, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const ct = (res.headers['content-type'] || '').toLowerCase();
          if (ct.includes('application/json')) {
            try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
          } else {
            resolve(data);
          }
        });
      }).on('error', err => reject(err));
    } catch (e) { reject(e); }
  });
}

function fetchJsonUrlWithCookies(url, cookieHeader) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const opts = {
        hostname: u.hostname,
        path: u.pathname + (u.search || ''),
        method: 'GET',
        headers: {
          'User-Agent': 'node.js',
          'Cookie': cookieHeader || ''
        }
      };
      const req = https.request(opts, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const ct = (res.headers['content-type'] || '').toLowerCase();
          if (ct.includes('application/json')) {
            try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
          } else {
            resolve(data);
          }
        });
      });
      req.on('error', err => reject(err));
      req.end();
    } catch (e) { reject(e); }
  });
}

function readCookieInputFromFileOrEnv(envKeys, fallbackNames = [], requiredFileNames = []) {
  const envValues = (Array.isArray(envKeys) ? envKeys : [envKeys])
    .map(key => process.env[key])
    .filter(value => typeof value === 'string' && value.trim());

  try {
    const files = fs.readdirSync(__dirname);
    const preferred = requiredFileNames.find(name => files.includes(name));
    if (preferred) return fs.readFileSync(path.join(__dirname, preferred), 'utf8');

    const candidate = files.find(f => fallbackNames.some(pattern => new RegExp(pattern, 'i').test(f)) || /cookie|cookies/i.test(f));
    if (candidate) return fs.readFileSync(path.join(__dirname, candidate), 'utf8');
  } catch (e) {}

  for (const envVal of envValues) {
    try {
      const candidatePath = path.isAbsolute(envVal) ? envVal : path.join(process.cwd(), envVal);
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
        return fs.readFileSync(candidatePath, 'utf8');
      }
      const trimmed = envVal.trim();
      if (trimmed.includes('=') || trimmed.includes(';') || trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('Cookie:')) {
        return trimmed;
      }
    } catch (e) {
      // fall through to the next source
    }
  }

  return null;
}

function normalizeWeightToKg(weight) {
  if (weight === null || weight === undefined || weight === '') return null;
  const numeric = Number(weight);
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 300) return Math.round(numeric / 1000);
  return Math.round(numeric);
}

function extractProfileFromZwiftRacingPage(html, userId) {
  if (!html || typeof html !== 'string') return null;
  try {
    const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (m && m[1]) {
      const parsed = JSON.parse(m[1]);
      const rider = parsed?.props?.pageProps?.rider || parsed?.rider || null;
      if (!rider) return null;
      const name = rider.name || rider.fullName || rider.displayName || rider.username || rider.userName || `User ${userId}`;
      const weight = rider.weight != null ? Number(rider.weight) : null;
      const height = rider.height != null ? Number(rider.height) : null;
      let ftp = rider.ftp != null ? Number(rider.ftp) : null;
      if (ftp == null && Array.isArray(rider.history)) {
        const historyFtp = rider.history.map(h => Number(h?.ftp)).find(v => !Number.isNaN(v));
        if (historyFtp != null) ftp = historyFtp;
      }

      const phenotypeScores = rider?.phenotype?.overall?.scores || rider?.phenotype?.scores || rider?.phenotype || null;
      const maybeSprinter = phenotypeScores && (phenotypeScores.sprinter ?? phenotypeScores['sprinter-percentile'] ?? phenotypeScores.Sprinter ?? null);
      const maybePuncher = phenotypeScores && (phenotypeScores.puncheur ?? phenotypeScores.puncher ?? phenotypeScores['puncheur-percentile'] ?? phenotypeScores['puncher-percentile'] ?? null);
      const maybeClimber = phenotypeScores && (phenotypeScores.climber ?? phenotypeScores['climber-percentile'] ?? null);

      const sprinter = maybeSprinter != null ? Number(maybeSprinter) : null;
      const puncher = maybePuncher != null ? Number(maybePuncher) : null;
      const climber = maybeClimber != null ? Number(maybeClimber) : null;
      const velo1 = rider?.race?.rating != null ? Number(rider.race.rating) : null;

      return {
        name,
        weight: Number.isFinite(weight) ? weight : null,
        height: Number.isFinite(height) ? height : null,
        ftp: Number.isFinite(ftp) ? ftp : null,
        velo1: Number.isFinite(velo1) ? velo1 : null,
        sprinter: Number.isFinite(sprinter) ? sprinter : null,
        puncher: Number.isFinite(puncher) ? puncher : null,
        climber: Number.isFinite(climber) ? climber : null,
        source: 'zwiftracing'
      };
    }
  } catch (e) {
    // fall through to null
  }
  return null;
}

async function fetchZwiftRacingProfile(userId) {
  const tpl = process.env.ZWIFTRACING_URL_TEMPLATE || 'https://www.zwiftracing.app/riders/{id}';
  const url = tpl.replace('{id}', encodeURIComponent(String(userId)));
  try {
    const cookieHeader = loadZwiftRacingCookieHeader();
    const body = cookieHeader ? await fetchJsonUrlWithCookies(url, cookieHeader) : await fetchJsonUrl(url);
    if (!body) return null;

    if (typeof body === 'string') {
      return extractProfileFromZwiftRacingPage(body, userId);
    }

    if (body && typeof body === 'object') {
      const rider = body?.props?.pageProps?.rider || body?.rider || null;
      if (!rider) return null;
      const profile = extractProfileFromZwiftRacingPage(JSON.stringify(body), userId);
      return profile || {
        name: rider.name || rider.fullName || rider.displayName || rider.username || rider.userName || `User ${userId}`,
        weight: rider.weight != null ? Number(rider.weight) : null,
        height: rider.height != null ? Number(rider.height) : null,
        ftp: rider.ftp != null ? Number(rider.ftp) : null,
        velo1: rider?.race?.rating != null ? Number(rider.race.rating) : null,
        sprinter: rider?.phenotype?.overall?.scores?.sprinter != null ? Number(rider.phenotype.overall.scores.sprinter) : null,
        puncher: rider?.phenotype?.overall?.scores?.puncheur != null ? Number(rider.phenotype.overall.scores.puncheur) : null,
        climber: rider?.phenotype?.overall?.scores?.climber != null ? Number(rider.phenotype.overall.scores.climber) : null,
        source: 'zwiftracing'
      };
    }

    return null;
  } catch (e) {
    return null;
  }
}

function loadZwiftRacingCookieHeader() {
  const raw = readCookieInputFromFileOrEnv(['ZWIFTRACING_COOKIES', 'ZWIFTRACING_COOKIE_FILE'], ['zwiftracing', 'zwift.*cookie', 'cookies'], ['zwiftracing_cookies.txt', 'zwiftracing_cookies.json', 'www.zwiftracing.app_cookies.json']);
  if (!raw) return null;

  if (!raw) return null;

  raw = raw.trim();
  try {
    const parsed = JSON.parse(raw);
    // Browser-exported array of cookies
    if (Array.isArray(parsed)) {
      return parsed.map(c => (c.name || c.key) + '=' + (c.value || '')).join('; ');
    }
    // Tough-cookie jar format
    if (parsed && parsed.cookies && Array.isArray(parsed.cookies)) {
      return parsed.cookies.map(c => (c.key || c.name) + '=' + (c.value || '')).join('; ');
    }
  } catch (e) {
    // Not JSON - maybe raw cookie string
  }

  // Fallback: assume raw is cookie header string
  return raw;
}

function loadZwiftRacingCookiesArray() {
  const raw = readCookieInputFromFileOrEnv(['ZWIFTRACING_COOKIES', 'ZWIFTRACING_COOKIE_FILE'], ['zwiftracing', 'zwift.*cookie', 'cookies'], ['zwiftracing_cookies.txt', 'zwiftracing_cookies.json', 'www.zwiftracing.app_cookies.json']);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && parsed.cookies && Array.isArray(parsed.cookies)) return parsed.cookies;
  } catch (e) {}

  const cookiePairs = raw
    .replace(/^Cookie:\s*/i, '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(pair => {
      const idx = pair.indexOf('=');
      if (idx <= 0) return null;
      return {
        name: pair.slice(0, idx).trim(),
        value: pair.slice(idx + 1).trim(),
        domain: 'www.zwiftracing.app',
        path: '/',
        httpOnly: true,
        secure: true
      };
    })
    .filter(Boolean);

  return cookiePairs;
}

async function fetchZwiftRacingCategory(userId) {
  const tpl = process.env.ZWIFTRACING_URL_TEMPLATE || 'https://www.zwiftracing.app/riders/{id}';
  const url = tpl.replace('{id}', encodeURIComponent(String(userId)));
  try {
    const cookieHeader = loadZwiftRacingCookieHeader();
    const body = cookieHeader ? await fetchJsonUrlWithCookies(url, cookieHeader) : await fetchJsonUrl(url);
    if (!body) return null;
    if (typeof body === 'object') {
      return body.category || body.cat || body.racingCategory || null;
    }
    const m = String(body).match(/Category[:\s]*([A-E]|[A-E]\d|[A-E]\b)/i);
    if (m && m[1]) return m[1].toUpperCase();
    const m2 = String(body).match(/class=["']?cat["']?[^>]*>\s*([A-E])\s*</i);
    if (m2 && m2[1]) return m2[1].toUpperCase();
    return null;
  } catch (e) {
    return null;
  }
}

// Fetch Velo1 scores (best-effort). Tries JSON endpoint first, then falls back to page scraping.
async function fetchVeloScores(userId) {
  const tpl = process.env.ZWIFTRACING_URL_TEMPLATE || 'https://www.zwiftracing.app/riders/{id}';
  const url = tpl.replace('{id}', encodeURIComponent(String(userId)));
  try {
    const cookieHeader = loadZwiftRacingCookieHeader();
    const body = cookieHeader ? await fetchJsonUrlWithCookies(url, cookieHeader) : await fetchJsonUrl(url);
    if (!body) return { velo1: null };
    if (typeof body === 'object') {
      const keys = Object.keys(body || {});
      if (process.env.ZWIFTRACING_DEBUG === '1') console.log(`  → fetchVeloScores: JSON keys: ${keys.join(',')}`);
      const maybeV1 = body.race || body.rider?.race || body.race?.rating || body.raceRating || null;
      const v1 = maybeV1 && typeof maybeV1 === 'object' ? (maybeV1.rating || maybeV1.race || null) : maybeV1;
      return { velo1: v1 ? Math.round(Number(v1)) : null };
    }

    const txt = String(body || '');
    if (process.env.ZWIFTRACING_DEBUG === '1') console.log('  → fetchVeloScores: body snippet:', txt.slice(0, 1000));

    const m = txt.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (m && m[1]) {
      try {
        const parsed = JSON.parse(m[1]);
        const rider = parsed?.props?.pageProps?.rider || parsed?.rider || null;
        if (rider) {
          const velo1 = rider?.race?.rating ?? rider?.race ?? null;
          return { velo1: velo1 ? Math.round(Number(velo1)) : null };
        }
      } catch (e) {
        if (process.env.ZWIFTRACING_DEBUG === '1') console.log('  ⚠ __NEXT_DATA__ JSON parse failed:', e.message);
      }
    }

    const v1 = (txt.match(/\b(rating|Rating|Current)[:\s]*([0-9]{3,5})/i) || txt.match(/racing[:\s]*([0-9]{3,5})/i) || [])[2]
      || (txt.match(/rider.*\"race\".*rating":\s*([0-9]{3,5})/i) || [])[1];
    const out = { velo1: v1 ? parseInt(v1, 10) : null };
    if ((!out.velo1) && process.env.ZWIFTRACING_SAVE_VELO_HTML === '1') {
      try {
        const outDir = path.join(__dirname, 'output');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
        const outPath = path.join(outDir, `zwiftracing_${userId}_raw.html`);
        fs.writeFileSync(outPath, txt, 'utf8');
        console.log(`  → Saved zwiftracing HTML to ${outPath}`);
      } catch (e) {
        if (process.env.ZWIFTRACING_DEBUG === '1') console.log('  ⚠ Could not save HTML:', e.message);
      }
    }
    return out;
  } catch (e) {
    return { velo1: null };
  }
}

// Puppeteer helpers
let _puppeteerBrowser = null;
let _puppeteerPage = null;
let _puppeteerLoggedIn = false;

async function initPuppeteerAndLogin() {
  if (!puppeteer) {
    try { puppeteer = require('puppeteer'); } catch (e) { return false; }
  }
  if (_puppeteerBrowser) return true;
  const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] };
  _puppeteerBrowser = await puppeteer.launch(launchOpts);
  _puppeteerPage = await _puppeteerBrowser.newPage();
  // If credentials are provided, use login flow. Otherwise try to load cookie export and set cookies.
  const username = process.env.ZWIFTRACING_USERNAME;
  const password = process.env.ZWIFTRACING_PASSWORD;
  if (username && password) {
    const loginUrl = process.env.ZWIFTRACING_LOGIN_URL || 'https://www.zwiftracing.app/login';
    const userSel = process.env.ZWIFTRACING_LOGIN_USERNAME_SELECTOR || 'input[name="email"]';
    const passSel = process.env.ZWIFTRACING_LOGIN_PASSWORD_SELECTOR || 'input[name="password"]';
    const submitSel = process.env.ZWIFTRACING_LOGIN_SUBMIT_SELECTOR || 'button[type="submit"]';
    try {
      await _puppeteerPage.goto(loginUrl, { waitUntil: 'networkidle2' });
      await _puppeteerPage.waitForTimeout(500);
      try { await _puppeteerPage.waitForSelector(userSel, { timeout: 3000 }); } catch (e) {}
      await _puppeteerPage.type(userSel, username, { delay: 50 });
      await _puppeteerPage.type(passSel, password, { delay: 50 });
      await Promise.all([
        _puppeteerPage.click(submitSel),
        _puppeteerPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {})
      ]);
      _puppeteerLoggedIn = true;
      return true;
    } catch (e) {
      // fallthrough to cookie attempt
    }
  }

  // Try loading cookie export and set into page
  const cookiesArr = loadZwiftRacingCookiesArray();
  if (cookiesArr && cookiesArr.length > 0) {
    try {
      // Map cookie objects to Puppeteer format
      const puppeteerCookies = cookiesArr.map(c => {
        const cookie = { name: c.name || c.key, value: c.value || c.value === 0 ? String(c.value) : '', path: c.path || '/', domain: c.domain || undefined, httpOnly: !!c.httpOnly, secure: !!c.secure };
        if (c.expirationDate) cookie.expires = Math.floor(Number(c.expirationDate));
        return cookie;
      });
      console.log(`  → Puppeteer: setting ${puppeteerCookies.length} cookies from export`);
      await _puppeteerPage.setCookie(...puppeteerCookies);
      // Navigate to homepage to ensure cookies are applied
      console.log('  → Puppeteer: navigating to verify session');
      await _puppeteerPage.goto('https://www.zwiftracing.app/', { waitUntil: 'networkidle2' });
      console.log('  → Puppeteer: navigation complete (cookie session applied)');
      _puppeteerLoggedIn = true;
      return true;
    } catch (e) {
      console.log('  ⚠ Puppeteer cookie injection failed:', e && e.message ? e.message : e);
      return false;
    }
  }

  return false;
}

async function fetchWithPuppeteerCategory(userId) {
  if (!_puppeteerPage || !_puppeteerLoggedIn) return null;
  const tpl = process.env.ZWIFTRACING_ATHLETE_URL_TEMPLATE || 'https://www.zwiftracing.app/riders/{id}';
  const url = tpl.replace('{id}', encodeURIComponent(String(userId)));
  try {
    await _puppeteerPage.goto(url, { waitUntil: 'networkidle2' });
    const sel = process.env.ZWIFTRACING_CATEGORY_SELECTOR;
    if (sel) {
      try {
        const txt = await _puppeteerPage.$eval(sel, el => el.textContent && el.textContent.trim());
        if (txt) return txt.trim();
      } catch (e) {}
    }
    // fallback: try regex on page text
    const bodyText = await _puppeteerPage.evaluate(() => document.body.innerText);
    // Optionally save full rendered HTML for inspection
    try {
      if (process.env.ZWIFTRACING_SAVE_HTML === '1') {
        const html = await _puppeteerPage.content();
        const outDir = path.join(__dirname, 'output');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
        const outPath = path.join(outDir, `zwiftracing_${userId}.html`);
        fs.writeFileSync(outPath, html, 'utf8');
        console.log(`  → Saved rendered page to ${outPath}`);
      }
    } catch (e) {
      // ignore save errors
    }
    if (process.env.ZWIFTRACING_DEBUG === '1') {
      console.log('ZWIFTRACING DEBUG: page text snippet:\n', String(bodyText).slice(0,1000));
    }
    const m = String(bodyText).match(/Category[:\s]*([A-E][0-9]?|[A-E])/i);
    if (m && m[1]) return m[1].toUpperCase();
    // Try matching common ZwiftRacing tier names
    const tiers = ['Sapphire','Emerald','Diamond','Platinum','Gold','Silver','Bronze','Ruby','Iron'];
    for (const t of tiers) {
      if (String(bodyText).toLowerCase().indexOf(t.toLowerCase()) !== -1) return t;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchWithPuppeteerVelo(userId) {
  if (!_puppeteerPage || !_puppeteerLoggedIn) return { velo1: null };
  const tpl = process.env.ZWIFTRACING_ATHLETE_URL_TEMPLATE || 'https://www.zwiftracing.app/riders/{id}';
  const url = tpl.replace('{id}', encodeURIComponent(String(userId)));
  try {
    await _puppeteerPage.goto(url, { waitUntil: 'networkidle2' });
    let txt = '';
    try {
      const nextData = await _puppeteerPage.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        return el ? el.textContent : null;
      });
      if (nextData) txt = String(nextData);
    } catch (e) {
      // ignore
    }
    if (!txt) {
      const bodyText = await _puppeteerPage.evaluate(() => document.body.innerText || '');
      txt = String(bodyText || '');
    }
    let v1 = null;
    try {
      const parsed = JSON.parse(txt);
      const rider = parsed?.props?.pageProps?.rider || parsed?.rider || null;
      if (rider) {
        v1 = rider?.race?.rating ? Math.round(Number(rider.race.rating)) : (rider?.race ? Math.round(Number(rider.race)) : null);
      }
    } catch (e) {
      const v1m = txt.match(/Velo\s*1[:\s]*([0-9]{2,5})/i) || txt.match(/velo1[:\s]*([0-9]{2,5})/i) || txt.match(/Velo[:\s]*([0-9]{3,5})/i) || [];
      v1 = v1m[1] ? parseInt(v1m[1], 10) : null;
    }
    if ((!v1) && process.env.ZWIFTRACING_SAVE_VELO_HTML === '1') {
      try {
        const html = await _puppeteerPage.content();
        const outDir = path.join(__dirname, 'output');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
        const outPath = path.join(outDir, `zwiftracing_${userId}_rendered.html`);
        fs.writeFileSync(outPath, html, 'utf8');
        console.log(`  → Saved rendered zwiftracing page to ${outPath}`);
      } catch (e) {
        if (process.env.ZWIFTRACING_DEBUG === '1') console.log('  ⚠ Could not save rendered HTML:', e.message);
      }
    }
    if (process.env.ZWIFTRACING_DEBUG === '1') console.log(`  → fetchWithPuppeteerVelo: found v1=${v1}`);
    return { velo1: v1 };
  } catch (e) {
    return { velo1: null };
  }
}

async function closePuppeteer() {
  try {
    if (_puppeteerPage) await _puppeteerPage.close();
    if (_puppeteerBrowser) await _puppeteerBrowser.close();
  } catch (e) {}
  _puppeteerPage = null;
  _puppeteerBrowser = null;
  _puppeteerLoggedIn = false;
}

// Global flag to control saving raw JSON responses (off by default)
let SAVE_RAW = false;

// Extract power data from ZwiftPower API response
function extractPowerFromZwiftPower(data, weight) {
  const durations = {
    '15s': '15s',
    '30s': '30s',
    '1min': '1min',
    '2min': '2min',
    '5min': '5min',
    '20min': '20min'
  };

  const result = {};

  if (!data) {
    Object.keys(durations).forEach(label => {
      result[`${label}_watts`] = null;
      result[`${label}_wkg`] = null;
    });
    return result;
  }

  // ZwiftPower returns power records in their data object
  Object.entries(durations).forEach(([label, key]) => {
    const powerRecord = data[key] || data[label];
    const watts = powerRecord ? parseInt(powerRecord, 10) : null;
    result[`${label}_watts`] = watts;
    result[`${label}_wkg`] = watts && weight ? (watts / weight).toFixed(2) : null;
  });

  return result;
}

// Extract power data from an array of segments (alternative response shape)
function extractPowerFromSegments(segments, weight) {
  const durations = {
    '15s': 15,
    '30s': 30,
    '1min': 60,
    '2min': 120,
    '5min': 300,
    '20min': 1200
  };

  const result = {};

  if (!segments || segments.length === 0) {
    Object.keys(durations).forEach(key => {
      result[`${key}_watts`] = null;
      result[`${key}_wkg`] = null;
    });
    return result;
  }

  Object.entries(durations).forEach(([label, targetSeconds]) => {
    let bestWatts = null;
    for (const segment of segments) {
      if ((segment.duration === targetSeconds || segment.segment_seconds === targetSeconds) && segment.watts) {
        if (bestWatts === null || segment.watts > bestWatts) {
          bestWatts = segment.watts;
        }
      }
    }

    result[`${label}_watts`] = bestWatts;
    result[`${label}_wkg`] = bestWatts && weight ? (bestWatts / weight).toFixed(2) : null;
  });

  return result;
}

// Extract power data from an 'efforts' array (e.g. body.efforts.90days -> [{x:15,y:778},...])
function extractPowerFromEfforts(effortsArray, weight) {
  const durations = {
    '15s': 15,
    '30s': 30,
    '1min': 60,
    '2min': 120,
    '5min': 300,
    '20min': 1200
  };

  const result = {};
  if (!effortsArray || !Array.isArray(effortsArray) || effortsArray.length === 0) {
    Object.keys(durations).forEach(key => {
      result[`${key}_watts`] = null;
      result[`${key}_wkg`] = null;
    });
    return result;
  }

  Object.entries(durations).forEach(([label, targetSeconds]) => {
    let foundWatts = null;
    for (const point of effortsArray) {
      // some shapes use x, some use segment_seconds; y or watts for value
      const xs = point.x || point.segment_seconds || point.duration || null;
      const val = (point.y !== undefined) ? point.y : (point.watts !== undefined ? point.watts : null);
      if (xs !== null && Number(xs) === targetSeconds && val !== null) {
        foundWatts = Number(val);
        break;
      }
    }

    result[`${label}_watts`] = foundWatts;
    result[`${label}_wkg`] = foundWatts && weight ? (foundWatts / weight).toFixed(2) : null;
  });

  return result;
}

// Find the best efforts array from a cpResult.efforts object (prefer 90day keys)
function findBestEffortsArray(effortsObj) {
  if (!effortsObj || typeof effortsObj !== 'object') return null;
  const keys = Object.keys(effortsObj);
  if (keys.length === 0) return null;
  // prefer common 90-day keys
  const prefer = ['90days','90_days','90day','90-day','90d','90'];
  for (const p of prefer) {
    const match = keys.find(k => k.toLowerCase().includes(p));
    if (match && Array.isArray(effortsObj[match])) return effortsObj[match];
  }
  // fallback: choose the longest array present
  let best = null;
  for (const k of keys) {
    if (Array.isArray(effortsObj[k])) {
      if (!best || effortsObj[k].length > best.length) best = effortsObj[k];
    }
  }
  return best;
}

// Process single user
async function processUser(zwiftApi, zwiftPowerApi, userId) {
  console.log(`\n[${new Date().toLocaleTimeString()}] Fetching data for user ${userId}...`);
  
  try {
    // Prepare scope for fallback handling
    let profile;
    let firstName = '';
    let lastName = '';
    let name = `User ${userId}`;
    let weight = null;
    let ftp = null;
    let sprinter = null;
    let puncher = null;
    let climber = null;

    // Get user profile: prefer Zwift API when available, otherwise ZwiftPower (best-effort)
    console.log(`  → Retrieving profile...`);
    async function getProfileFromZwiftPower(api, id) {
      const tryFns = ['getProfile','getAthlete','getUser','getUserProfile','getAthleteProfile','getProfileById'];
      for (const fn of tryFns) {
        try {
          if (typeof api[fn] === 'function') {
            const resp = await api[fn](id);
            if (!resp) continue;
            // Normalize shapes: { statusCode, body } or direct object
            let p = resp;
            if (resp.body !== undefined) p = (typeof resp.body === 'string' && resp.body.trim()) ? JSON.parse(resp.body) : resp.body;
            if (p && (p.firstName || p.weight || p.ftp || p.name || p.username)) return p;
          }
        } catch (e) {
          // ignore and try next
        }
      }
      return null;
    }
    // Try ZwiftAPI profile first if we have credentials and an instance
    if (zwiftApi) {
      try {
        profile = await zwiftApi.getProfile(userId);
        if (profile && profile.body !== undefined) {
          profile = profile.body && typeof profile.body === 'string' ? (profile.body.trim() ? JSON.parse(profile.body) : null) : profile.body;
        }
      } catch (e) {
        if (process.env.ZWIFTRACING_DEBUG === '1') console.log('  ⚠ Zwift API profile fetch failed, falling back to ZwiftPower:', e.message || e);
        profile = null;
      }
    }

    if (!profile) {
      profile = await getProfileFromZwiftPower(zwiftPowerApi, userId);
    }

    if (!profile) {
      console.log('  ⚠ No profile returned from APIs; continuing with minimal defaults');
      profile = {};
    }

    // If profile is missing expected fields, optionally save full profile for inspection
    if ((!profile || !profile.weight) && (!profile || !profile.ftp)) {
      if (SAVE_RAW) {
        try {
          const outDir = path.join(__dirname, 'output');
          if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
          const ts = Date.now();
          const rawProfilePath = path.join(outDir, `zwift_profile_raw_${userId}_${ts}.json`);
          fs.writeFileSync(rawProfilePath, JSON.stringify(profile, null, 2), 'utf8');
          console.log(`  → Saved raw Zwift profile to ${rawProfilePath}`);
        } catch (saveErr) {
          console.log(`  ⚠ Could not save raw Zwift profile: ${saveErr.message}`);
        }
      }
    }

    // Handle different possible name fields
    firstName = profile.firstName || '';
    lastName = profile.lastName || '';
    name = `${firstName} ${lastName}`.trim() || `User ${userId}`;

    weight = normalizeWeightToKg(profile.weight); // Convert grams to kg when needed
    ftp = profile.ftp || null;
    // Normalize height to cm when available
    let height = null;
    if (profile.height !== undefined && profile.height !== null) {
      const rawH = Number(profile.height);
      if (!isNaN(rawH)) {
        if (rawH > 1000) {
          // likely millimetres -> convert to cm
          height = Math.round(rawH / 10);
        } else {
          height = Math.round(rawH);
        }
      }
    }

    // Best-effort fallback: query ZwiftRacing public HTML for embedded rider data when the API payload is empty
    const hasAnyProfileData = Boolean(
      profile?.firstName || profile?.lastName || profile?.name ||
      profile?.weight != null || profile?.ftp != null ||
      weight != null || ftp != null || height != null
    );
    if (!hasAnyProfileData) {
      try {
        const tpl = process.env.ZWIFTRACING_URL_TEMPLATE || 'https://www.zwiftracing.app/riders/{id}';
        const url = tpl.replace('{id}', encodeURIComponent(String(userId)));
        const response = await fetchJsonUrl(url);
        if (typeof response === 'string') {
          const zrProfile = extractProfileFromZwiftRacingPage(response, userId);
          if (zrProfile) {
            if (!name || name === `User ${userId}`) name = zrProfile.name || name;
            if (zrProfile.weight != null && !weight) weight = normalizeWeightToKg(zrProfile.weight);
            if (zrProfile.ftp != null && !ftp) ftp = zrProfile.ftp;
            if (zrProfile.height != null && !height) height = zrProfile.height;
            if (zrProfile.sprinter != null) sprinter = zrProfile.sprinter;
            if (zrProfile.puncher != null) puncher = zrProfile.puncher;
            if (zrProfile.climber != null) climber = zrProfile.climber;
            console.log(`  → Populated profile from ZwiftRacing public page (${zrProfile.source})`);
          }
        }
      } catch (e) {
        if (process.env.ZWIFTRACING_DEBUG === '1') console.log('  ⚠ ZwiftRacing profile fallback failed:', e && e.message ? e.message : e);
      }
    }
    
    console.log(`  ✓ Profile found: ${name}`);
    console.log(`  → Weight: ${weight ? weight + ' kg' : 'N/A'}, FTP: ${ftp ? ftp + 'W' : 'N/A'}`);
    
    // Get critical power profile via wrapper (preferred; provides efforts data)
    let powerProfile = null;
    try {
      console.log(`  → Retrieving critical power profile...`);
      const cpResp = await zwiftPowerApi.getCriticalPowerProfile(userId);
      // cpResp shape: { statusCode, body }
      let cpResult = cpResp && cpResp.body ? cpResp.body : null;

      // Check if we got HTML instead of JSON (indicates auth failure - cookies expired)
      if (typeof cpResult === 'string' && cpResult.includes('<!DOCTYPE html')) {
        console.log(`  ⚠ CRITICAL: ZwiftPower returned HTML login page - cookies may be expired`);
        console.log(`  ⚠ Please refresh your ZwiftPower cookies:`);
        console.log(`     1. Log in to https://www.zwiftpower.com`);
        console.log(`     2. Export cookies using a browser extension (EditThisCookie, Cookie-Editor, etc.)`);
        console.log(`     3. Replace the contents of zwiftpower_cookies.json with the exported cookies`);
        console.log(`     4. Re-run the script`);
        
        // Save the HTML response for debugging
        try {
          const outDir = path.join(__dirname, 'output');
          if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
          const ts = Date.now();
          const debugPath = path.join(outDir, `zwiftpower_auth_failure_${userId}_${ts}.html`);
          fs.writeFileSync(debugPath, cpResult, 'utf8');
          console.log(`  → Saved auth failure HTML to ${debugPath} for debugging`);
        } catch (e) {
          // ignore save errors
        }
        cpResult = null; // Treat as failed auth
      }

      // Optionally save raw critical power response for inspection
      if (SAVE_RAW && cpResult) {
        try {
          const outDir = path.join(__dirname, 'output');
          if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
          const ts = Date.now();
          const rawPath = path.join(outDir, `zwiftpower_cp_raw_${userId}_${ts}.json`);
          fs.writeFileSync(rawPath, JSON.stringify(cpResp, null, 2), 'utf8');
          console.log(`  → Saved raw ZwiftPower critical profile to ${rawPath}`);
        } catch (saveErr) {
          console.log(`  ⚠ Could not save critical power response: ${saveErr.message}`);
        }
      }

      // NOTE: do not prefer segments for power values. Keep original API shapes intact.
      // We avoid converting 'efforts' -> 'segments' automatically because raw API 'data' should be authoritative.

      if (cpResult) {
        powerProfile = cpResult;
        // Prefer efforts.90days block when present
        const effortsArray = cpResult.efforts ? findBestEffortsArray(cpResult.efforts) : null;
        if (effortsArray && effortsArray.length > 0) {
          console.log(`  ✓ Critical power profile retrieved (efforts array, ${effortsArray.length} points)`);
        } else if (cpResult.segments && cpResult.segments.length > 0) {
          console.log(`  ✓ Critical power profile retrieved (${cpResult.segments.length} segments)`);
        } else {
          console.log('  ⚠ Critical power profile returned no segments/efforts');
        }
      } else {
        console.log('  ⚠ Critical power profile returned no segments');
      }
      // If we don't have a profile from ZwiftPower API methods, try to extract basic profile info from the CP response
      if ((!profile || !profile.weight || !profile.ftp || !profile.firstName) && cpResult) {
        try {
          const candidate = cpResult.athlete || cpResult.rider || cpResult.user || cpResult.player || cpResult.profile || cpResult.meta || cpResult;
          if (candidate) {
            // Name handling
            const fullName = candidate.name || candidate.fullName || candidate.displayName || candidate.username || candidate.userName || candidate.athlete_name || null;
            if (fullName) {
              const parts = String(fullName).trim().split(/\s+/);
              profile.firstName = parts.shift() || '';
              profile.lastName = parts.join(' ') || '';
            }

            // Weight handling: try common keys and normalize to grams like original code expects
            const weightCandidate = candidate.weight_kg || candidate.weight || candidate.mass || candidate.bodyWeight || candidate.weightKg || null;
            if (weightCandidate !== undefined && weightCandidate !== null) {
              let rawW = Number(weightCandidate);
              if (!isNaN(rawW)) {
                // If value looks like kg (<=300) keep as kg; if >300 assume grams
                if (rawW > 300) {
                  // likely grams -> keep raw as grams
                  profile.weight = rawW;
                } else {
                  // likely kg -> convert to grams for consistency with existing code
                  profile.weight = Math.round(rawW * 1000);
                }
              }
            }

            // FTP
            const ftpCandidate = candidate.ftp || candidate.ftp_estimate || candidate.functionalThresholdPower || null;
            if (ftpCandidate !== undefined && ftpCandidate !== null) profile.ftp = Number(ftpCandidate) || profile.ftp;

            // Height: try to normalize (cm expected)
            const h = candidate.height || candidate.height_cm || candidate.torso || null;
            if (h !== undefined && h !== null) {
              const rawH = Number(h);
              if (!isNaN(rawH)) {
                if (rawH > 1000) profile.height = Math.round(rawH / 10);
                else profile.height = Math.round(rawH);
              }
            }
            if (process.env.ZWIFTRACING_DEBUG === '1') console.log('  → extracted profile from cpResult:', { name: fullName, weight: profile.weight, ftp: profile.ftp, height: profile.height });
          }
        } catch (e) {
          if (process.env.ZWIFTRACING_DEBUG === '1') console.log('  ⚠ Could not extract profile from cpResult:', e && e.message ? e.message : e);
        }
      }
    } catch (e) {
      console.log(`  ⚠ Warning: Could not fetch critical power profile - ${e.message}`);
      powerProfile = null;
    }

    // Normalize power data across possible response shapes.
    // Prefer explicit API 'data' fields or direct object fields over inferred 'segments'.
    let powerData = {};
    if (powerProfile && powerProfile.data) {
      powerData = extractPowerFromZwiftPower(powerProfile.data, weight);
    } else if (powerProfile && powerProfile.efforts) {
      const effortsArray = findBestEffortsArray(powerProfile.efforts);
      if (effortsArray) {
        powerData = extractPowerFromEfforts(effortsArray, weight);
      } else {
        powerData = extractPowerFromZwiftPower(null, weight);
      }
    } else if (powerProfile && typeof powerProfile === 'object' &&
               Object.keys(powerProfile).some(k => ['15s','30s','1min','2min','5min','20min','5s'].includes(k))) {
      powerData = extractPowerFromZwiftPower(powerProfile, weight);
    } else if (powerProfile && powerProfile.segments && Array.isArray(powerProfile.segments)) {
      // Only use segments if explicitly allowed via env var
      if (process.env.ZWIFT_ALLOW_SEGMENTS === '1') {
        powerData = extractPowerFromSegments(powerProfile.segments, weight);
      } else {
        powerData = extractPowerFromZwiftPower(null, weight);
      }
    } else {
      powerData = extractPowerFromZwiftPower(null, weight);
    }

    // Optionally save the raw critical power response for inspection
    const savePowerProfile = process.env.ZWIFT_SAVE_POWERPROFILE === '1' || SAVE_RAW;
    if (savePowerProfile && powerProfile) {
      try {
        const outDir = path.join(__dirname, 'output');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
        const ts = Date.now();
        const rawPath = path.join(outDir, `zwiftpower_cp_raw_${userId}_${ts}.json`);
        fs.writeFileSync(rawPath, JSON.stringify(powerProfile, null, 2), 'utf8');
        console.log(`  → Saved raw ZwiftPower critical profile to ${rawPath}`);
      } catch (e) {
        console.log(`  ⚠ Could not save critical power response: ${e.message}`);
      }
    }

    console.log(`  ✓ Successfully processed user ${userId}`);

    // Try to get Velo1 and phenotype percentiles from ZwiftRacing.app (best-effort)
    let velo1 = null;
    try {
      const zrProfile = await fetchZwiftRacingProfile(userId);
      if (zrProfile) {
        if (zrProfile.velo1 != null) velo1 = zrProfile.velo1;
        if (zrProfile.sprinter != null) sprinter = zrProfile.sprinter;
        if (zrProfile.puncher != null) puncher = zrProfile.puncher;
        if (zrProfile.climber != null) climber = zrProfile.climber;
      }

      if (velo1 === null) {
        if (_puppeteerPage && _puppeteerLoggedIn) {
          const v = await fetchWithPuppeteerVelo(userId);
          if (v) {
            velo1 = v.velo1 || null;
          }
        }
        if (velo1 === null) {
          const v2obj = await fetchVeloScores(userId);
          if (v2obj) {
            velo1 = v2obj.velo1 || null;
          }
        }
      }

      if (velo1 === null) {
        const fallback = await fetchVeloScores(userId);
        if (fallback) {
          velo1 = fallback.velo1 || null;
        }
      }
    } catch (e) {
      velo1 = null; sprinter = null; puncher = null; climber = null;
    }

    return {
      userId: userId,
      name: name,
      weight: weight,
      height: height,
      ftp: ftp,
      velo1: velo1,
      sprinter: sprinter,
      puncher: puncher,
      climber: climber,
      ...powerData
    };
  } catch (error) {
    // Handle cases where an upstream library returns non-JSON (HTML) or parsing errors.
    if (error && error.message && /Unexpected token/.test(error.message)) {
      console.warn(`  ⚠ Non-JSON response encountered while fetching power data: ${error.message}`);
      // Return a minimal record containing profile info (if available) and null power fields
      const powerData = extractPowerFromSegments(null, weight);
      return {
        userId: userId,
        name: name,
        weight: weight,
        ftp: ftp,
        ...powerData
      };
    }

    

    console.error(`  ✗ Error fetching data for user ${userId}:`, error.message);
    return null;
  }
}

// Convert data to CSV
function convertToCSV(users) {
  const headers = [
    'User ID', 'Name', 'Weight (kg)', 'Height (cm)', 'FTP', 'Velo1',
    'Sprinter %', 'Puncher %', 'Climber %',
    '15s W/kg', '30s W/kg', '1min W/kg', '2min W/kg', '5min W/kg', '20min W/kg',
    '15s Watts', '30s Watts', '1min Watts', '2min Watts', '5min Watts', '20min Watts'
  ];

  const rows = users.map(user => [
    user.userId,
    `"${user.name}"`, // Quote names to handle commas
    user.weight,
    user.height || '',
    user.ftp,
    user.velo1 || '',
    user.sprinter != null ? user.sprinter : '',
    user.puncher != null ? user.puncher : '',
    user.climber != null ? user.climber : '',
    user['15s_wkg'], user['30s_wkg'], user['1min_wkg'], user['2min_wkg'], user['5min_wkg'], user['20min_wkg'],
    user['15s_watts'], user['30s_watts'], user['1min_watts'], user['2min_watts'], user['5min_watts'], user['20min_watts']
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => cell === null ? '' : cell).join(','))
  ].join('\n');

  return csvContent;
}

// Main function
async function main() {
  console.log('\n=== Zwift Data Fetcher ===\n');
  
  // Get credentials from environment variables (optional)
  const username = process.env.ZWIFT_USERNAME;
  const password = process.env.ZWIFT_PASSWORD;

  // Parse CLI flags: treat any `--` args as flags, remaining args as Zwift IDs
  const rawArgs = process.argv.slice(2);
  const debugFlag = rawArgs.includes('--debug') || rawArgs.includes('--save-raw') || !!process.env.DEBUG;
  SAVE_RAW = debugFlag;
  const userIds = rawArgs.filter(a => !a.startsWith('--'));

  if (!username || !password) {
    console.warn('⚠ No Zwift username/password set. The script will attempt ZwiftPower auth using cookies or unauthenticated requests.');
  }

  if (userIds.length === 0) {
    console.log('Usage: node zwift-fetcher.js <userId1> [userId2] [userId3] ...');
    console.log('Example: node zwift-fetcher.js 123456 234567 345678 456789 567890');
    console.log('\nYou can provide any number of user IDs (at least 1 required)');
    process.exit(1);
  }

  console.log(`[${new Date().toLocaleTimeString()}] Authenticating with Zwift/ ZwiftPower...`);

  // Create API instances. Zwift credentials are optional; if absent, the script will
  // rely on the ZwiftPower/ZwiftRacing data sources for profile and power information.
  let zwiftApi = null;
  if (username && password) {
    try {
      zwiftApi = new ZwiftAPI(username, password);
    } catch (e) {
      zwiftApi = null;
    }
  }
  const zwiftPowerApi = new ZwiftPowerAPI(username, password);

  // Authenticate with Zwift API if available
  if (zwiftApi) {
    try {
      await zwiftApi.authenticate();
      console.log('✓ Zwift authentication successful!');
    } catch (e) {
      console.log('⚠ Zwift authentication failed, continuing without Zwift API:', e.message || e);
      zwiftApi = null;
    }
  }

  // Authenticate with ZwiftPower. This is required for ZwiftPower-specific data.
  // If it fails, the run should stop rather than silently falling back.
  console.log('→ Authenticating with ZwiftPower...');
    try {
      // Allow passing serialized cookie jar for ZwiftPower via env var or file
      const zwpCookiesEnv = process.env.ZWIFTPOWER_COOKIES || process.env.ZWIFTPOWER_COOKIE_FILE;
      const zwpCookiesFile = process.env.ZWIFTPOWER_COOKIE_FILE;
      let zwpCookies = undefined;

      // Helper: try to auto-detect cookie files in this folder (common exports)
      function findLocalCookieFile() {
        try {
          const files = fs.readdirSync(__dirname);
          const candidate = files.find(f => /zwift.*cookie|cookies|zwiftpower.*cookie/i.test(f));
          if (candidate) return path.join(__dirname, candidate);
        } catch (e) {}
        return null;
      }

      if (zwpCookiesEnv) {
        const maybePath = path.isAbsolute(zwpCookiesEnv) ? zwpCookiesEnv : path.join(process.cwd(), zwpCookiesEnv);
        if (fs.existsSync(maybePath) && fs.statSync(maybePath).isFile()) {
          zwpCookies = normalizeZwiftPowerCookies(fs.readFileSync(maybePath, 'utf8'));
          console.log(`  → Using ZwiftPower cookies from file ${zwpCookiesEnv}`);
        } else if (zwpCookiesEnv.includes('=') || zwpCookiesEnv.includes(';') || zwpCookiesEnv.startsWith('{') || zwpCookiesEnv.startsWith('[') || zwpCookiesEnv.startsWith('Cookie:')) {
          zwpCookies = normalizeZwiftPowerCookies(zwpCookiesEnv);
          console.log('  → Using ZwiftPower cookies from ZWIFTPOWER_COOKIES env var');
        }
      }

      if (!zwpCookies) {
        const preferredNames = ['zwiftpower_cookies.txt', 'zwiftpower_cookies.json', 'zwp_cookies.json'];
        const localPath = preferredNames
          .map(name => path.join(__dirname, name))
          .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
          || findLocalCookieFile();
        if (localPath) {
          try {
            zwpCookies = normalizeZwiftPowerCookies(fs.readFileSync(localPath, 'utf8'));
            console.log(`  → Using ZwiftPower cookies from local file ${path.basename(localPath)}`);
          } catch (e) {
            console.log(`  ⚠ Could not read detected cookie file: ${e.message}`);
          }
        }
      }

      if (zwpCookies) {
        await zwiftPowerApi.authenticate(zwpCookies);
      } else {
        await zwiftPowerApi.authenticate();
      }
      console.log('✓ ZwiftPower authentication successful!\n');
    } catch (zpError) {
      console.log('⚠ ZwiftPower authentication failed.');
      console.log(`  (Error: ${zpError.message})\n`);
      throw zpError;
    }
  

  console.log(`📊 Fetching data for ${userIds.length} user(s)...`);

  // Initialize Puppeteer login for ZwiftRacing if requested
  const cookieExportPresent = !!loadZwiftRacingCookiesArray();
  console.log('→ ZwiftRacing Puppeteer check - env user/pass:', !!process.env.ZWIFTRACING_USERNAME, !!process.env.ZWIFTRACING_PASSWORD, 'cookieExportPresent:', cookieExportPresent);
  const wantPuppeteer = process.env.ZWIFTRACING_USE_PUPPETEER === '1'
    || (process.env.ZWIFTRACING_USERNAME && process.env.ZWIFTRACING_PASSWORD)
    || cookieExportPresent;
  if (wantPuppeteer) {
    try {
      const ok = await initPuppeteerAndLogin();
      if (ok) console.log('✓ Puppeteer: logged in to ZwiftRacing.app');
      else console.log('⚠ Puppeteer: could not login (check env selectors/credentials)');
    } catch (e) {
      console.log('⚠ Puppeteer initialization failed:', e.message || e);
    }
  }

  // Fetch all user data
  const users = [];
  for (let i = 0; i < userIds.length; i++) {
    const userId = userIds[i];
    console.log(`\n[${i + 1}/${userIds.length}] Processing user ${userId}`);
    
    const userData = await processUser(zwiftApi, zwiftPowerApi, userId);
    if (userData) {
      users.push(userData);
    }
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (users.length === 0) {
    console.error('\n✗ No user data could be fetched.');
    process.exit(1);
  }

  console.log('\n📁 Saving results...');

  // Convert to CSV and save
  const csv = convertToCSV(users);
  
  // Create output folder if it doesn't exist
  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
    console.log('  → Created output folder');
  }
  
  const filename = path.join(outputDir, `zwift_data_${Date.now()}.csv`);
  
  fs.writeFileSync(filename, csv);
  console.log(`\n✓ Data saved to ${filename}`);
  console.log(`✓ Successfully processed ${users.length} of ${userIds.length} user(s).`);
  
  if (users.length < userIds.length) {
    console.log(`⚠ Warning: ${userIds.length - users.length} user(s) could not be processed.`);
  }
  try { await closePuppeteer(); } catch (e) {}

  console.log('\n=== Complete ===\n');
}

// Run the program
if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}

module.exports = {
  normalizeZwiftPowerCookies,
  normalizeWeightToKg,
  extractProfileFromZwiftRacingPage
};