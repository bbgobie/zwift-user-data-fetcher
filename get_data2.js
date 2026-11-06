const fs = require('fs');
const path = require('path');
const https = require('https');

const COOKIE_FILE = path.join(__dirname, 'zwiftracing_cookies.txt');
const OUTPUT_DIR = path.join(__dirname, 'output');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseCookieHeader(rawText) {
  if (!rawText) return '';
  const text = rawText.trim();
  if (!text) return '';

  try {
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) {
      return parsed
        .map((c) => `${c.name || c.key}=${c.value || ''}`)
        .join('; ');
    }

    if (parsed && Array.isArray(parsed.cookies)) {
      return parsed.cookies
        .map((c) => `${c.name || c.key}=${c.value || ''}`)
        .join('; ');
    }
  } catch (e) {
    // fall through to raw string handling below
  }

  return text.replace(/^Cookie\s*:\s*/i, '').trim();
}

function readCookieHeader() {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(`Missing cookie file: ${COOKIE_FILE}`);
  }
  const raw = fs.readFileSync(COOKIE_FILE, 'utf8');
  const header = parseCookieHeader(raw);
  if (!header) {
    throw new Error('Cookie file is empty or malformed.');
  }
  return header;
}

function requestText(url, cookieHeader, redirectsRemaining = 5) {
  return new Promise((resolve, reject) => {
    const requestUrl = typeof url === 'string' ? url : url.toString();
    const req = https.get(requestUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': cookieHeader
      }
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        if (redirectsRemaining <= 0) {
          reject(new Error(`Too many redirects while fetching ${requestUrl}`));
          return;
        }
        const nextUrl = new URL(res.headers.location, requestUrl).toString();
        res.resume();
        resolve(requestText(nextUrl, cookieHeader, redirectsRemaining - 1));
        return;
      }

      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (status >= 400) {
          reject(new Error(`HTTP ${status} for ${requestUrl}`));
          return;
        }
        resolve(body);
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function requestJson(url, cookieHeader) {
  const text = await requestText(url, cookieHeader);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function coerceNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = coerceNumber(item);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  if (typeof value === 'object') {
    const nested = value.value ?? value.amount ?? value.num ?? value.val ?? value.data ?? null;
    return coerceNumber(nested);
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = Number(raw.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function findNextDataPayload(html) {
  if (!html || typeof html !== 'string') return null;
  const matches = [...html.matchAll(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of matches) {
    if (!match[1]) continue;
    try {
      return JSON.parse(match[1]);
    } catch (e) {
      // continue trying other script blocks
    }
  }
  return null;
}

function readBalancedObject(text, openBraceIndex) {
  if (openBraceIndex === undefined || openBraceIndex < 0 || text[openBraceIndex] !== '{') return null;

  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplateLiteral = false;

  for (let i = openBraceIndex; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];

    if (inSingleQuote) {
      if (ch === '\'' && prev !== '\\') inSingleQuote = false;
      continue;
    }

    if (inDoubleQuote) {
      if (ch === '"' && prev !== '\\') inDoubleQuote = false;
      continue;
    }

    if (inTemplateLiteral) {
      if (ch === '`' && prev !== '\\') inTemplateLiteral = false;
      continue;
    }

    if (ch === '\'') inSingleQuote = true;
    else if (ch === '"') inDoubleQuote = true;
    else if (ch === '`') inTemplateLiteral = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openBraceIndex, i + 1);
    }
  }

  return null;
}

function parseJsLiteral(rawLiteral) {
  if (!rawLiteral || typeof rawLiteral !== 'string') return null;
  const sanitized = rawLiteral.replace(/!0/g, 'true').replace(/!1/g, 'false');
  try {
    const $R = [];
    return Function('$R', '"use strict"; return (' + sanitized + ');')($R);
  } catch (e) {
    return null;
  }
}

function findRuntimeAppObject(html, needle) {
  if (!html || typeof html !== 'string') return null;
  const index = html.indexOf(needle);
  if (index < 0) return null;

  const openBrace = html.lastIndexOf('{', index);
  if (openBrace < 0) return null;

  const literal = readBalancedObject(html, openBrace);
  if (!literal) return null;

  return parseJsLiteral(literal);
}

function findRuntimeValueByKeyword(html, keyword) {
  if (!html || typeof html !== 'string') return null;
  const index = html.indexOf(keyword);
  if (index < 0) return null;
  const start = html.indexOf('{', index + keyword.length);
  const openBracket = html.indexOf('[', index + keyword.length);
  const startIndex = start >= 0 && (openBracket === -1 || start < openBracket) ? start : openBracket;
  if (startIndex < 0) return null;

  const literal = startIndex === openBracket
    ? readBalancedArray(html, openBracket)
    : readBalancedObject(html, startIndex);
  if (!literal) return null;

  return parseJsLiteral(literal);
}

function findRuntimeObjectByKeyword(html, keyword) {
  if (!html || typeof html !== 'string') return null;
  const index = html.indexOf(keyword);
  if (index < 0) return null;
  const start = html.indexOf('{', index + keyword.length);
  if (start < 0) return null;
  const literal = readBalancedObject(html, start);
  if (!literal) return null;
  return parseJsLiteral(literal);
}

function readBalancedArray(text, openBracketIndex) {
  if (openBracketIndex === undefined || openBracketIndex < 0 || text[openBracketIndex] !== '[') return null;

  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplateLiteral = false;

  for (let i = openBracketIndex; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];

    if (inSingleQuote) {
      if (ch === '\'' && prev !== '\\') inSingleQuote = false;
      continue;
    }

    if (inDoubleQuote) {
      if (ch === '"' && prev !== '\\') inDoubleQuote = false;
      continue;
    }

    if (inTemplateLiteral) {
      if (ch === '`' && prev !== '\\') inTemplateLiteral = false;
      continue;
    }

    if (ch === '\'') inSingleQuote = true;
    else if (ch === '"') inDoubleQuote = true;
    else if (ch === '`') inTemplateLiteral = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(openBracketIndex, i + 1);
    }
  }

  return null;
}

function pickRiderFromPayload(payload) {
  if (!payload) return null;
  if (payload && typeof payload === 'object' && payload.riderId && payload.name) return payload;
  return payload?.props?.pageProps?.rider || payload?.rider || payload?.props?.rider || null;
}

function parseRuntimeRider(html, userId) {
  const needle = `riderId:${userId}`;
  const object = findRuntimeAppObject(html, needle);
  if (!object) return null;
  if (object.riderId && object.name) return object;
  if (object.l && object.l.riderId && object.l.name) return object.l;
  if (object.props && object.props.pageProps && object.props.pageProps.rider) return object.props.pageProps.rider;
  return null;
}

function parseRuntimePowerObject(html, keyword = 'power:$R') {
  const index = html.indexOf(keyword);
  if (index < 0) return null;
  const openBrace = html.lastIndexOf('{', index);
  if (openBrace < 0) return null;
  const literal = readBalancedObject(html, openBrace);
  if (!literal) return null;
  return parseJsLiteral(literal);
}

function pickPhenotypeScores(rider) {
  const candidates = [
    rider?.phenotype?.overall?.compare?.gender?.scores,
    rider?.phenotype?.compare?.gender?.scores,
    rider?.compare?.gender?.scores,
    rider?.phenotype?.overall?.scores,
    rider?.phenotype?.scores,
    rider?.phenotype?.overall?.compare?.men?.scores,
    rider?.phenotype?.compare?.men?.scores,
    rider?.compare?.men?.scores,
    rider?.phenotype?.overall?.compare?.gender,
    rider?.phenotype?.compare?.gender,
    rider?.phenotype?.overall?.compare?.men,
    rider?.phenotype?.compare?.men,
    rider?.compare?.gender,
    rider?.compare?.men,
    rider?.phenotype || null
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') return candidate;
  }

  return null;
}

function readPercentileValue(rawObject, labels) {
  for (const key of labels) {
    const value = rawObject?.[key] ?? rawObject?.[key.toLowerCase()] ?? rawObject?.[key.toUpperCase()] ?? null;
    if (value !== null && value !== undefined) {
      const number = coerceNumber(value);
      if (number !== null) return number;
    }
    const alt = rawObject?.[`$\{key\}-percentile`] ?? rawObject?.[`${key}_percentile`] ?? rawObject?.[`${key}-percentile`] ?? rawObject?.[`${key}_percentile`];
    if (alt !== null && alt !== undefined) {
      const number = coerceNumber(alt);
      if (number !== null) return number;
    }
  }
  return null;
}

function parseRiderOverview(html, userId) {
  const payload = findNextDataPayload(html) || parseRuntimeRider(html, userId);
  const rider = pickRiderFromPayload(payload);
  if (!rider) return null;

  const phenotypeScores = pickPhenotypeScores(rider);
  const data = {
    userId,
    name: (rider.name || rider.fullName || rider.displayName || rider.username || rider.userName || `User ${userId}`).replace(/\s+\([^)]*\)$/, ''),
    weight: coerceNumber(rider.weight),
    height: coerceNumber(rider.height),
    ftp: coerceNumber(rider.ftp ?? rider.thresholdPower ?? null),
    velo1: coerceNumber(rider.legacyRatings?.live ?? rider.legacyRatings?.max90 ?? rider.legacyRatings?.max30 ?? rider.race?.rating ?? null),
    velo2: coerceNumber(rider.ratings?.live ?? rider.ratings?.max90 ?? rider.ratings?.max30 ?? rider.race?.rating ?? null),
    sprinter: readPercentileValue(phenotypeScores, ['sprinter', 'sprint']) ?? coerceNumber(phenotypeScores?.sprinter ?? phenotypeScores?.['sprinter-percentile'] ?? phenotypeScores?.['sprinter_percentile'] ?? null),
    puncher: readPercentileValue(phenotypeScores, ['puncheur', 'puncher', 'punch']) ?? coerceNumber(phenotypeScores?.puncheur ?? phenotypeScores?.puncher ?? phenotypeScores?.['puncheur-percentile'] ?? phenotypeScores?.['puncher-percentile'] ?? phenotypeScores?.['puncheur_percentile'] ?? phenotypeScores?.['puncher_percentile'] ?? null),
    climber: readPercentileValue(phenotypeScores, ['climber', 'climb']) ?? coerceNumber(phenotypeScores?.climber ?? phenotypeScores?.['climber-percentile'] ?? phenotypeScores?.['climber_percentile'] ?? null)
  };

  const ratingSet = findRuntimeObjectByKeyword(html, 'ratings') || {};
  const legacyRatingSet = findRuntimeObjectByKeyword(html, 'legacyRatings') || {};
  if (ratingSet.live != null) data.velo2 = coerceNumber(ratingSet.live) ?? data.velo2;
  if (legacyRatingSet.live != null) data.velo1 = coerceNumber(legacyRatingSet.live) ?? data.velo1;

  if (data.ftp === null && Array.isArray(rider.history)) {
    const ftpFromHistory = rider.history
      .map((entry) => coerceNumber(entry?.ftp ?? entry?.thresholdPower ?? null))
      .find((v) => v !== null);
    if (ftpFromHistory !== undefined) data.ftp = ftpFromHistory;
  }

  return data;
}

function parseRiderOverviewFromApi(payload, userId) {
  const data = payload && typeof payload === 'object' && payload.data ? payload.data : payload;
  if (!data || typeof data !== 'object') return null;

  const rider = data.rider || data;
  if (!rider || typeof rider !== 'object') return null;

  const name = (rider.name || rider.fullName || rider.displayName || rider.username || rider.userName || `User ${userId}`).replace(/\s+\([^)]*\)$/, '');
  const weight = coerceNumber(rider.weight ?? rider.latest?.[0]?.race?.weight ?? null);
  const height = coerceNumber(rider.height ?? rider.latest?.[0]?.race?.height ?? null);
  const ftp = coerceNumber(rider.ftp ?? rider.thresholdPower ?? data.ftp ?? data.thresholdPower ?? null);
  const legacyRatings = rider.legacyRatings || data.legacyRatings || {};
  const ratings = rider.ratings || data.ratings || {};
  const velo1 = coerceNumber(legacyRatings.live ?? legacyRatings.max90 ?? legacyRatings.max30 ?? rider.race?.rating ?? data.race?.rating ?? null);
  const velo2 = coerceNumber(ratings.live ?? ratings.max90 ?? ratings.max30 ?? rider.race?.rating ?? data.race?.rating ?? null);

  return {
    userId,
    name,
    weight,
    height,
    ftp,
    velo1,
    velo2,
    sprinter: null,
    puncher: null,
    climber: null
  };
}

function mergeNonNullValues(...sources) {
  const merged = {};
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source)) {
      if (value !== null && value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function findPowerPointsInObject(source) {
  const results = [];

  function walk(node) {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const hasPowerLikeKeys = Object.keys(node).some((key) => {
      const normalized = key.toLowerCase();
      return ['x', 'y', 'watts', 'power', 'duration', 'segment_seconds', 'seconds', 'wkg', 'value'].includes(normalized);
    });

    if (hasPowerLikeKeys) {
      results.push(node);
    }

    for (const value of Object.values(node)) {
      walk(value);
    }
  }

  walk(source);
  return results;
}

function extractPhenotypePercentilesFromPercentilesPayload(payload) {
  const data = payload && typeof payload === 'object' && payload.data ? payload.data : payload;
  const factors = data && typeof data === 'object' ? (data.factors || {}) : {};

  return {
    sprinter: coerceNumber(factors.sprint?.percentile ?? factors.sprinter?.percentile ?? null),
    puncher: coerceNumber(factors.punch?.percentile ?? factors.puncheur?.percentile ?? factors.puncher?.percentile ?? null),
    climber: coerceNumber(factors.climb?.percentile ?? factors.climber?.percentile ?? null)
  };
}

function buildPercentilesUrl(apiBase, compareMode = 'gender') {
  const params = new URLSearchParams();

  if (compareMode === 'gender') {
    params.set('age', 'all');
    params.set('band', 'all');
  } else if (compareMode === 'genderAge') {
    params.set('band', 'all');
  } else if (compareMode === 'genderCategory') {
    params.set('age', 'all');
  } else if (compareMode === 'womensCategory') {
    params.set('age', 'all');
    params.set('ladder', 'women');
  } else if (compareMode === 'category') {
    params.set('gender', 'all');
    params.set('age', 'all');
  }

  const query = params.toString();
  return query ? `${apiBase}/power/percentiles?${query}` : `${apiBase}/power/percentiles`;
}

function extractPowerFromPowerPage(html, weightKg) {
  const payload = findNextDataPayload(html) || parseRuntimePowerObject(html, 'power:$R');
  const ftpMetric = findRuntimeValueByKeyword(html, 'id:"ftp"') || findRuntimeValueByKeyword(html, "id:'ftp'");
  const ftp = coerceNumber(ftpMetric?.d90?.w ?? ftpMetric?.live?.w ?? ftpMetric?.d90?.watts ?? ftpMetric?.live?.watts ?? null);

  if (!payload) return ftp !== null ? { ftp } : {};

  const points = findPowerPointsInObject(payload);
  const durationMap = {
    '15s': 15,
    '30s': 30,
    '1min': 60,
    '2min': 120,
    '5min': 300,
    '20min': 1200
  };

  const values = {};
  const directKV = {};

  function applyObject(obj) {
    for (const [key, value] of Object.entries(obj)) {
      const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
      const match = normalizedKey.match(/^(wkg|watts)?(15|30|60|120|300|1200)$/);
      if (match) {
        const suffix = match[2];
        const seconds = Number(suffix);
        const mappedSeconds = seconds === 60 ? 60 : seconds === 120 ? 120 : seconds === 300 ? 300 : seconds === 1200 ? 1200 : seconds;
        const kind = match[1] ? (match[1] === 'wkg' ? 'wkg' : 'watts') : null;
        if (kind === 'wkg' || kind === 'watts') {
          if (!directKV[mappedSeconds]) directKV[mappedSeconds] = { watts: null, wkg: null };
          directKV[mappedSeconds][kind] = coerceNumber(value);
        }
      }
    }
  }

  applyObject(payload);

  for (const point of points) {
    const seconds = coerceNumber(point.x ?? point.segment_seconds ?? point.duration ?? point.seconds ?? null);
    if (seconds === null) continue;

    const watts = coerceNumber(point.d90?.w ?? point.live?.w ?? point.y ?? point.watts ?? point.power ?? point.value ?? null);
    const wkg = coerceNumber(point.d90?.wkg ?? point.live?.wkg ?? point.wkg ?? point.watts_per_kg ?? point.wattsPerKg ?? point.watts_per_kg ?? point.w_per_kg ?? null);
    const normalizedSeconds = Number(seconds);
    if (!values[normalizedSeconds]) values[normalizedSeconds] = { watts: null, wkg: null };

    if (watts !== null && (values[normalizedSeconds].watts === null || watts > values[normalizedSeconds].watts)) {
      values[normalizedSeconds].watts = watts;
      values[normalizedSeconds].wkg = wkg ?? values[normalizedSeconds].wkg;
    }
  }

  const result = {
    ftp,
    '15s_watts': null,
    '30s_watts': null,
    '1min_watts': null,
    '2min_watts': null,
    '5min_watts': null,
    '20min_watts': null,
    '15s_wkg': null,
    '30s_wkg': null,
    '1min_wkg': null,
    '2min_wkg': null,
    '5min_wkg': null,
    '20min_wkg': null
  };

  for (const [label, seconds] of Object.entries(durationMap)) {
    const key = `${label}_watts`;
    const wkgKey = `${label}_wkg`;
    const matched = values[seconds] || directKV[seconds] || null;
    const watts = matched?.watts ?? null;
    const rawWkg = matched?.wkg ?? (watts !== null && weightKg ? watts / weightKg : null);
    const wkg = rawWkg !== null && rawWkg !== undefined ? Number(Number(rawWkg).toFixed(2)) : null;

    result[key] = watts;
    result[wkgKey] = wkg;
  }

  return result;
}

function extractPowerFromApiPayload(payload, weightKg) {
  const data = payload && typeof payload === 'object' && payload.data ? payload.data : payload;
  if (!data || typeof data !== 'object') return {};

  const curve = Array.isArray(data.curve) ? data.curve : Array.isArray(data.power?.curve) ? data.power.curve : [];
  const ftp = coerceNumber(data.ftp ?? data.thresholdPower ?? null);
  const result = {
    ftp,
    '15s_watts': null,
    '30s_watts': null,
    '1min_watts': null,
    '2min_watts': null,
    '5min_watts': null,
    '20min_watts': null,
    '15s_wkg': null,
    '30s_wkg': null,
    '1min_wkg': null,
    '2min_wkg': null,
    '5min_wkg': null,
    '20min_wkg': null
  };

  for (const entry of curve) {
    if (!entry || typeof entry !== 'object') continue;
    const seconds = Number(entry.durationSec ?? entry.seconds ?? 0);
    if (!Number.isFinite(seconds)) continue;
    const kindMap = {
      15: '15s',
      30: '30s',
      60: '1min',
      120: '2min',
      300: '5min',
      1200: '20min'
    };
    const label = kindMap[seconds];
    if (!label) continue;

    const watts = coerceNumber(entry.d90?.w ?? entry.live?.w ?? entry.watts ?? entry.value ?? null);
    const wkg = coerceNumber(entry.d90?.wkg ?? entry.live?.wkg ?? entry.wkg ?? null);
    result[`${label}_watts`] = watts;
    result[`${label}_wkg`] = wkg != null ? Number(Number(wkg).toFixed(2)) : (watts != null && weightKg ? Number((watts / weightKg).toFixed(2)) : null);
  }

  return result;
}

function writeCsv(rows) {
  ensureDir(OUTPUT_DIR);
  const headers = [
    'User ID',
    'Name',
    'Weight (kg)',
    'Height (cm)',
    'FTP',
    'Velo1',
    'Velo2',
    'Sprinter %',
    'Puncher %',
    'Climber %',
    '15s W/kg',
    '30s W/kg',
    '1min W/kg',
    '2min W/kg',
    '5min W/kg',
    '20min W/kg',
    '15s Watts',
    '30s Watts',
    '1min Watts',
    '2min Watts',
    '5min Watts',
    '20min Watts'
  ];

  const csvRows = rows.map((row) => [
    row.userId,
    `"${(row.name || '').replace(/"/g, '""')}"`,
    row.weight != null ? Math.round(Number(row.weight)) : '',
    row.height != null ? Math.round(Number(row.height)) : '',
    row.ftp != null ? Math.round(Number(row.ftp)) : '',
    row.velo1 != null ? Math.round(Number(row.velo1)) : '',
    row.velo2 != null ? Math.round(Number(row.velo2)) : '',
    row.sprinter != null ? Number(row.sprinter).toFixed(1) : '',
    row.puncher != null ? Number(row.puncher).toFixed(1) : '',
    row.climber != null ? Number(row.climber).toFixed(1) : '',
    row['15s_wkg'] != null ? Number(row['15s_wkg']).toFixed(2) : '',
    row['30s_wkg'] != null ? Number(row['30s_wkg']).toFixed(2) : '',
    row['1min_wkg'] != null ? Number(row['1min_wkg']).toFixed(2) : '',
    row['2min_wkg'] != null ? Number(row['2min_wkg']).toFixed(2) : '',
    row['5min_wkg'] != null ? Number(row['5min_wkg']).toFixed(2) : '',
    row['20min_wkg'] != null ? Number(row['20min_wkg']).toFixed(2) : '',
    row['15s_watts'] != null ? Math.round(Number(row['15s_watts'])) : '',
    row['30s_watts'] != null ? Math.round(Number(row['30s_watts'])) : '',
    row['1min_watts'] != null ? Math.round(Number(row['1min_watts'])) : '',
    row['2min_watts'] != null ? Math.round(Number(row['2min_watts'])) : '',
    row['5min_watts'] != null ? Math.round(Number(row['5min_watts'])) : '',
    row['20min_watts'] != null ? Math.round(Number(row['20min_watts'])) : ''
  ]);

  const content = [headers.join(','), ...csvRows.map((row) => row.join(','))].join('\n');
  const timestamped = path.join(OUTPUT_DIR, `zwift_data_${Date.now()}.csv`);
  const latest = path.join(OUTPUT_DIR, 'zwift_data_latest.csv');
  fs.writeFileSync(timestamped, content, 'utf8');
  fs.writeFileSync(latest, content, 'utf8');
  return { timestamped, latest, content };
}

async function fetchOneRider(userId) {
  const cookieHeader = readCookieHeader();
  const overviewUrl = `https://www.zwiftracing.app/riders/${encodeURIComponent(String(userId))}`;
  const compareUrl = `${overviewUrl}/velo?compare=gender`;
  const powerUrl = `${overviewUrl}/power`;
  const apiBase = `https://api.zwiftracing.app/api/v2/riders/${encodeURIComponent(String(userId))}`;

  const percentilesUrl = buildPercentilesUrl(apiBase, 'gender');

  const [overviewHtml, compareHtml, powerHtml, apiOverview, apiPower, apiPercentiles] = await Promise.all([
    requestText(overviewUrl, cookieHeader),
    requestText(compareUrl, cookieHeader),
    requestText(powerUrl, cookieHeader),
    requestJson(apiBase, cookieHeader),
    requestJson(`${apiBase}/power`, cookieHeader),
    requestJson(percentilesUrl, cookieHeader)
  ]);

  const pageOverview = parseRiderOverview(overviewHtml, userId) || {};
  const apiOverviewParsed = parseRiderOverviewFromApi(apiOverview, userId) || {};
  const overview = mergeNonNullValues(apiOverviewParsed, pageOverview);
  if (!overview || Object.keys(overview).length === 0) {
    throw new Error(`Could not parse overview page for rider ${userId}`);
  }

  const compareOverview = mergeNonNullValues(apiOverviewParsed, parseRiderOverview(compareHtml, userId) || {});
  const percentileValues = extractPhenotypePercentilesFromPercentilesPayload(apiPercentiles);
  const weightKg = overview.weight ? Number(overview.weight) : null;
  const pagePower = extractPowerFromPowerPage(powerHtml, weightKg) || {};
  const apiPowerParsed = extractPowerFromApiPayload(apiPower, weightKg) || {};
  const power = mergeNonNullValues(apiPowerParsed, pagePower);

  const finalRow = {
    userId,
    name: overview.name,
    weight: overview.weight,
    height: overview.height,
    ftp: power.ftp ?? overview.ftp ?? null,
    velo1: compareOverview.velo1 ?? overview.velo1 ?? null,
    velo2: compareOverview.velo2 ?? overview.velo2 ?? null,
    sprinter: percentileValues.sprinter ?? compareOverview.sprinter ?? overview.sprinter ?? null,
    puncher: percentileValues.puncher ?? compareOverview.puncher ?? overview.puncher ?? null,
    climber: percentileValues.climber ?? compareOverview.climber ?? overview.climber ?? null,
    ...power
  };

  return finalRow;
}

async function main() {
  const rawIds = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
  if (rawIds.length === 0) {
    console.log('Usage: node get_data2.js <zwiftId> [<zwiftId> ...]');
    process.exit(1);
  }

  const uniqueIds = [...new Set(rawIds)];
  const rows = [];

  for (const id of uniqueIds) {
    const riderId = Number(id);
    if (!Number.isFinite(riderId)) {
      throw new Error(`Invalid Zwift rider ID: ${id}`);
    }

    const row = await fetchOneRider(riderId);
    rows.push(row);
  }

  const result = writeCsv(rows);
  console.log(`Wrote ${rows.length} rider(s) to ${result.latest}`);
  console.log(result.content);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  parseCookieHeader,
  readCookieHeader,
  requestText,
  requestJson,
  coerceNumber,
  findNextDataPayload,
  parseJsLiteral,
  findRuntimeAppObject,
  findRuntimeObjectByKeyword,
  parseRuntimeRider,
  parseRiderOverview,
  parseRiderOverviewFromApi,
  mergeNonNullValues,
  extractPhenotypePercentilesFromPercentilesPayload,
  extractPowerFromPowerPage,
  extractPowerFromApiPayload,
  writeCsv,
  fetchOneRider,
  main
};
