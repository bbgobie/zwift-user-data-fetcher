const { ZwiftAPI, ZwiftPowerAPI } = require('@codingwithspike/zwift-api-wrapper');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

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

    // Get user profile
    console.log(`  → Retrieving profile...`);
    profile = await zwiftApi.getProfile(userId);
    // Normalize wrapper response shapes: some wrappers return { statusCode, body: {...} }
    if (profile && profile.body !== undefined) {
      profile = profile.body && typeof profile.body === 'string' ? (profile.body.trim() ? JSON.parse(profile.body) : null) : profile.body;
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

    weight = profile.weight ? profile.weight / 1000 : null; // Convert grams to kg
    ftp = profile.ftp || null;
    
    console.log(`  ✓ Profile found: ${name}`);
    console.log(`  → Weight: ${weight ? weight + ' kg' : 'N/A'}, FTP: ${ftp ? ftp + 'W' : 'N/A'}`);
    
    // Get critical power profile via wrapper (preferred; provides efforts data)
    let powerProfile = null;
    try {
      console.log(`  → Retrieving critical power profile...`);
      const cpResp = await zwiftPowerApi.getCriticalPowerProfile(userId);
      // cpResp shape: { statusCode, body }
      const cpResult = cpResp && cpResp.body ? cpResp.body : null;

      // Optionally save raw critical power response for inspection
      if (SAVE_RAW) {
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

      // Convert 'efforts' -> segments if necessary
      if (cpResult && !cpResult.segments && cpResult.efforts) {
        try {
          const effortArrays = Object.values(cpResult.efforts).filter(a => Array.isArray(a));
          if (effortArrays.length > 0) {
            effortArrays.sort((a, b) => b.length - a.length);
            const best = effortArrays[0];
            cpResult.segments = best.map(p => ({ segment_seconds: p.x, watts: p.y }));
          }
        } catch (e) {
          // ignore conversion errors
        }
      }

      if (cpResult && cpResult.segments && cpResult.segments.length > 0) {
        powerProfile = cpResult;
        console.log(`  ✓ Critical power profile retrieved (${powerProfile.segments.length} segments)`);
      } else {
        console.log('  ⚠ Critical power profile returned no segments');
      }
    } catch (e) {
      console.log(`  ⚠ Warning: Could not fetch critical power profile - ${e.message}`);
      powerProfile = null;
    }

    // Normalize power data across possible response shapes
    let powerData = {};
    if (powerProfile && powerProfile.segments && Array.isArray(powerProfile.segments)) {
      powerData = extractPowerFromSegments(powerProfile.segments, weight);
    } else if (powerProfile && powerProfile.data) {
      powerData = extractPowerFromZwiftPower(powerProfile.data, weight);
    } else if (powerProfile && typeof powerProfile === 'object') {
      powerData = extractPowerFromZwiftPower(powerProfile, weight);
    } else {
      powerData = extractPowerFromZwiftPower(null, weight);
    }

    console.log(`  ✓ Successfully processed user ${userId}`);

    return {
      userId: userId,
      name: name,
      weight: weight,
      ftp: ftp,
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
    'User ID', 'Name', 'Weight (kg)', 'FTP',
    '15s W/kg', '30s W/kg', '1min W/kg', '2min W/kg', '5min W/kg', '20min W/kg',
    '15s Watts', '30s Watts', '1min Watts', '2min Watts', '5min Watts', '20min Watts'
  ];

  const rows = users.map(user => [
    user.userId,
    `"${user.name}"`, // Quote names to handle commas
    user.weight,
    user.ftp,
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
  
  // Get credentials from environment variables
  const username = process.env.ZWIFT_USERNAME;
  const password = process.env.ZWIFT_PASSWORD;

  // Parse CLI flags: treat any `--` args as flags, remaining args as Zwift IDs
  const rawArgs = process.argv.slice(2);
  const debugFlag = rawArgs.includes('--debug') || rawArgs.includes('--save-raw') || !!process.env.DEBUG;
  SAVE_RAW = debugFlag;
  const userIds = rawArgs.filter(a => !a.startsWith('--'));

  if (!username || !password) {
    console.error('✗ Error: Zwift credentials not found!');
    console.error('Please set environment variables in .env file:');
    console.error('  ZWIFT_USERNAME=your_email@example.com');
    console.error('  ZWIFT_PASSWORD=your_password');
    process.exit(1);
  }

  if (userIds.length === 0) {
    console.log('Usage: node zwift-fetcher.js <userId1> [userId2] [userId3] ...');
    console.log('Example: node zwift-fetcher.js 123456 234567 345678 456789 567890');
    console.log('\nYou can provide any number of user IDs (at least 1 required)');
    process.exit(1);
  }

  console.log(`[${new Date().toLocaleTimeString()}] Authenticating with Zwift...`);
  
  // Create Zwift API instance
  const zwiftApi = new ZwiftAPI(username, password);
  const zwiftPowerApi = new ZwiftPowerAPI(username, password);
  
  try {
    await zwiftApi.authenticate();
    console.log('✓ Zwift authentication successful!');
    
    // Authenticate with ZwiftPower (slower and sometimes fails)
    console.log('→ Authenticating with ZwiftPower...');
    try {
      // Allow passing serialized cookie jar for ZwiftPower via env var or file
      const zwpCookiesEnv = process.env.ZWIFTPOWER_COOKIES;
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
        const raw = zwpCookiesEnv.trim();
        if (raw.startsWith('{') || raw.startsWith('[')) {
          zwpCookies = raw;
        } else {
          const cookieValue = raw;
          const jar = {
            version: 'tough-cookie@3.0.0',
            storeType: 'MemoryCookieStore',
            rejectPublicSuffixes: false,
            cookies: [
              {
                key: 'phpbb3_lswlk_sid',
                value: cookieValue,
                expires: 'Infinity',
                maxAge: null,
                domain: 'zwiftpower.com',
                path: '/',
                secure: false,
                httpOnly: true,
                extensions: null,
                creation: Date.now(),
                creationIndex: 1
              }
            ]
          };
          zwpCookies = JSON.stringify(jar);
          console.log('  → Converted raw cookie value to serialized cookie-jar format');
        }
        console.log('  → Using ZwiftPower cookies from ZWIFTPOWER_COOKIES env var');
      } else if (zwpCookiesFile) {
        try {
          zwpCookies = fs.readFileSync(path.resolve(zwpCookiesFile), 'utf8');
          console.log(`  → Using ZwiftPower cookies from file ${zwpCookiesFile}`);
        } catch (e) {
          console.log(`  ⚠ Could not read ZwiftPower cookies file: ${e.message}`);
        }
      } else {
        // Auto-detect common cookie export files in the project folder
        const localPath = findLocalCookieFile();
        if (localPath) {
          try {
            zwpCookies = fs.readFileSync(localPath, 'utf8');
            console.log(`  → Using ZwiftPower cookies from local file ${path.basename(localPath)}`);
          } catch (e) {
            console.log(`  ⚠ Could not read detected cookie file: ${e.message}`);
          }
        }
      }

      // Normalize cookie content: accept browser-exported arrays, tough-cookie jars, or raw session values
      if (zwpCookies) {
        const raw = zwpCookies.trim();
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            // Browser-exported cookie array -> convert to tough-cookie jar
            const cookiesArr = parsed;
            const jar = {
              version: 'tough-cookie@3.0.0',
              storeType: 'MemoryCookieStore',
              rejectPublicSuffixes: false,
              cookies: cookiesArr.map((c, idx) => ({
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
              }))
            };
            zwpCookies = JSON.stringify(jar);
            console.log('  → Converted browser-exported cookies to serialized cookie-jar format');
          } else if (parsed && parsed.cookies) {
            // Already a tough-cookie jar JSON
            zwpCookies = raw;
          } else {
            // Unknown JSON shape: leave as-is
            zwpCookies = raw;
          }
        } catch (e) {
          // Not JSON: treat as raw cookie value (e.g., phpbb3_lswlk_sid)
          const cookieValue = raw;
          const jar = {
            version: 'tough-cookie@3.0.0',
            storeType: 'MemoryCookieStore',
            rejectPublicSuffixes: false,
            cookies: [
              {
                key: 'phpbb3_lswlk_sid',
                value: cookieValue,
                expires: 'Infinity',
                maxAge: null,
                domain: 'zwiftpower.com',
                path: '/',
                secure: false,
                httpOnly: true,
                extensions: null,
                creation: Date.now(),
                creationIndex: 1
              }
            ]
          };
          zwpCookies = JSON.stringify(jar);
          console.log('  → Converted raw cookie value to serialized cookie-jar format');
        }
      }

      if (zwpCookies) {
        await zwiftPowerApi.authenticate(zwpCookies);
      } else {
        await zwiftPowerApi.authenticate();
      }
      console.log('✓ ZwiftPower authentication successful!\n');
    } catch (zpError) {
      console.log('⚠ ZwiftPower authentication had issues, will try to proceed anyway...');
      console.log(`  (Error: ${zpError.message})\n`);
    }
  } catch (error) {
    console.error('✗ Zwift authentication failed:', error.message);
    console.error('\nPlease check your credentials in the .env file.');
    process.exit(1);
  }

  console.log(`📊 Fetching data for ${userIds.length} user(s)...`);

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
  
  console.log('\n=== Complete ===\n');
}

// Run the program
main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});