const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function getAuthClient() {
  const {google} = require('googleapis');

  let key = null;
  if (process.env.SERVICE_ACCOUNT_KEY) {
    try { key = JSON.parse(process.env.SERVICE_ACCOUNT_KEY); } catch (e) { /* ignore */ }
  }
  if (!key && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const p = path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)
      ? process.env.GOOGLE_APPLICATION_CREDENTIALS
      : path.join(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS);
    if (fs.existsSync(p)) key = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  if (!key) {
    console.error('No service account credentials found. Set SERVICE_ACCOUNT_KEY (JSON) or GOOGLE_APPLICATION_CREDENTIALS file.');
    process.exit(1);
  }

  const auth = new (require('googleapis').google).auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return auth.getClient();
}

function findLatestCsv() {
  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) return null;
  const files = fs.readdirSync(outDir).filter(f => f.endsWith('.csv'));
  if (files.length === 0) return null;
  files.sort((a,b) => fs.statSync(path.join(outDir,b)).mtimeMs - fs.statSync(path.join(outDir,a)).mtimeMs);
  return path.join(outDir, files[0]);
}

function parseCsv(content) {
  // Lazy-load csv-parse to avoid hard dependency when not used
  let parse = null;
  try { parse = require('csv-parse/sync').parse; } catch (e) { parse = null; }
  if (!parse) {
    // very simple split fallback (won't handle quoted commas reliably)
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.map(l => l.split(',').map(c => c.replace(/^"|"$/g, '')));
  }
  return parse(content, { columns: false, skip_empty_lines: true });
}

async function main() {
  const csvFile = process.env.CSV_FILE || findLatestCsv();
  if (!csvFile) {
    console.error('No CSV file found. Place a CSV in output/ or set CSV_FILE.');
    process.exit(1);
  }
  const csv = fs.readFileSync(csvFile, 'utf8');
  const rows = parseCsv(csv);
  if (!rows || rows.length === 0) {
    console.error('CSV empty or could not be parsed.');
    process.exit(1);
  }

  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetTitle = process.env.SHEET_TITLE || `Zwift Data ${Date.now()}`;

  const client = await getAuthClient();
  const {google} = require('googleapis');
  const sheets = google.sheets({version: 'v4', auth: client});

  let sid = spreadsheetId;
  if (!sid) {
    // Create spreadsheet
    const createRes = await sheets.spreadsheets.create({
      requestBody: { properties: { title: sheetTitle } }
    });
    sid = createRes.data.spreadsheetId;
    console.log('Created spreadsheet:', sid);
  }

  // Use first row as header; write entire sheet starting at a fresh temporary sheet
  const values = rows.map(r => r.map(c => (c === null || c === undefined) ? '' : String(c)));
  const resource = { values };

  // fetch sheet metadata to find the original first sheet
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sid, includeGridData: false });
  const originalSheet = meta.data.sheets && meta.data.sheets[0];
  const originalSheetId = originalSheet.properties.sheetId;
  const originalTitle = originalSheet.properties.title || 'Sheet1';

  // create a temporary sheet to overwrite (so we start with a clean sheet)
  const tmpTitle = `${originalTitle} (tmp-${Date.now()})`;
  const addRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sid,
    requestBody: { requests: [{ addSheet: { properties: { title: tmpTitle } } }] }
  });
  const newSheet = addRes.data.replies && addRes.data.replies[0] && addRes.data.replies[0].addSheet && addRes.data.replies[0].addSheet.properties;
  const newSheetId = newSheet.sheetId;

  // write values into the temp sheet
  await sheets.spreadsheets.values.update({
    spreadsheetId: sid,
    range: `${tmpTitle}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: resource
  });
  // After writing data rows, append an averages row (formulas) so it's included in formatting
  const indexToA1 = (i) => {
    let col = '';
    i++;
    while (i > 0) {
      const rem = (i - 1) % 26;
      col = String.fromCharCode(65 + rem) + col;
      i = Math.floor((i - 1) / 26);
    }
    return col;
  };

  // build average row: label 'Average' in Name column, formulas for numeric columns
  const avgRow = [];
  for (let c = 0; c < values[0].length; c++) {
    const h = String(values[0][c] || '').toLowerCase();
    const colA1 = indexToA1(c);
    if (h.includes('name')) {
      avgRow.push('Average');
    } else if (h.includes('user id')) {
      avgRow.push('');
    } else {
      // numeric column — average the column from row 2 to last data row
      const start = `${colA1}2`;
      const end = `${colA1}${values.length}`;
      avgRow.push(`=AVERAGE(${start}:${end})`);
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sid,
    range: `${tmpTitle}!A${values.length + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [avgRow] }
  });

  // include avg row in local values so formatting counts it
  values.push(avgRow);

  console.log(`Wrote ${values.length} rows to spreadsheet: ${sid}`);
  console.log('Spreadsheet URL: https://docs.google.com/spreadsheets/d/' + sid);

  // Apply conditional formatting and styling to the new sheet
  try {
    // use the new sheet metadata for formatting
    const sheet = newSheet;
    const sheetId = newSheetId;

    // determine header row and number of rows
    const numRows = values.length;
    const headers = values[0].map(h => String(h).trim());

    const requests = [];

    // helper to convert hex color (#rrggbb) to Sheets Color object (0-1 floats)
    const hexToColor = (hex) => {
      const h = hex.replace('#', '');
      const r = parseInt(h.substring(0, 2), 16) / 255;
      const g = parseInt(h.substring(2, 4), 16) / 255;
      const b = parseInt(h.substring(4, 6), 16) / 255;
      return { red: r, green: g, blue: b };
    };

    // desired palette (user-specified)
    const GREEN = hexToColor('#34a853');
    const YELLOW = hexToColor('#fbbc04');
    const RED = hexToColor('#ea4335');

    for (let c = 0; c < headers.length; c++) {
      const h = headers[c].toLowerCase();
      // skip non-numeric columns
      if (h.includes('user id') || h.includes('name')) continue;

      // compute range: rows 2..numRows (1-indexed). In API it's 0-based, startRowIndex=1
      // Exclude the averages row from conditional formatting by ending at dataRows
      const dataRows = Math.max(1, numRows - 1);
      const range = {
        sheetId: sheetId,
        startRowIndex: 1,
        endRowIndex: dataRows,
        startColumnIndex: c,
        endColumnIndex: c + 1
      };

      // For weight/height: min green -> max red
      const isWeightOrHeight = h.includes('weight') || h.includes('height');

      // For weight/height: min = green, mid = yellow, max = red
      // For other numeric fields: min = red, mid = yellow, max = green
      const minColor = isWeightOrHeight ? GREEN : RED;
      const midColor = YELLOW;
      const maxColor = isWeightOrHeight ? RED : GREEN;

      const rule = {
        addConditionalFormatRule: {
          rule: {
            ranges: [range],
            gradientRule: {
              minpoint: { type: 'MIN', color: minColor },
              midpoint: { type: 'PERCENT', value: '50', color: midColor },
              maxpoint: { type: 'MAX', color: maxColor }
            }
          },
          index: 0
        }
      };
      requests.push(rule);
    }

    // Add header formatting, filter, and banding (table style)
    try {
      const headerRange = {
        sheetId: sheetId,
        startRowIndex: 0,
        endRowIndex: 1,
        startColumnIndex: 0,
        endColumnIndex: headers.length
      };

      // Bold header row
      requests.push({
        repeatCell: {
          range: headerRange,
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold'
        }
      });

      // Add filter across the data rows (exclude averages row)
      const dataRows = Math.max(1, numRows - 1);
      requests.push({
        setBasicFilter: {
          filter: {
            range: {
              sheetId: sheetId,
              startRowIndex: 0,
              endRowIndex: dataRows,
              startColumnIndex: 0,
              endColumnIndex: headers.length
            }
          }
        }
      });

      // Remove any existing banding on the sheet first (prevents addBanding errors)
      if (sheet.bandedRanges && sheet.bandedRanges.length) {
        for (const br of sheet.bandedRanges) {
          if (br && (br.bandedRangeId || br.bandedRangeId === 0)) {
            requests.push({ deleteBanding: { bandedRangeId: br.bandedRangeId } });
          }
        }
      }

      // Add banding to make it look like a table
      const HEADER_COLOR = hexToColor('#f3f6f9');
      const BAND1 = hexToColor('#ffffff');
      const BAND2 = hexToColor('#fbfbfb');
      // Add banding to make it look like a table, exclude averages row
      requests.push({
        addBanding: {
          bandedRange: {
            range: {
              sheetId: sheetId,
              startRowIndex: 0,
              endRowIndex: dataRows,
              startColumnIndex: 0,
              endColumnIndex: headers.length
            },
            rowProperties: {
              headerColor: HEADER_COLOR,
              firstBandColor: BAND1,
              secondBandColor: BAND2
            }
          }
        }
      });

      // Set column widths: Name = 100px, others = 55px
      for (let c = 0; c < headers.length; c++) {
        const colName = String(headers[c] || '').toLowerCase();
        const px = colName.includes('name') ? 100 : 55;
        requests.push({
          updateDimensionProperties: {
            range: {
              sheetId: sheetId,
              dimension: 'COLUMNS',
              startIndex: c,
              endIndex: c + 1
            },
            properties: { pixelSize: px },
            fields: 'pixelSize'
          }
        });
      }

      // Center all cells except the Name column, which should be left-aligned
      const nameIndex = headers.findIndex(h => String(h).toLowerCase().includes('name'));
      if (nameIndex === -1) {
        requests.push({
          repeatCell: {
            range: {
              sheetId: sheetId,
              startRowIndex: 0,
              endRowIndex: numRows,
              startColumnIndex: 0,
              endColumnIndex: headers.length
            },
            cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
            fields: 'userEnteredFormat.horizontalAlignment'
          }
        });
      } else {
        if (nameIndex > 0) {
          requests.push({
            repeatCell: {
              range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: nameIndex },
              cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
              fields: 'userEnteredFormat.horizontalAlignment'
            }
          });
        }
        // left-align the Name column
        requests.push({
          repeatCell: {
            range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: nameIndex, endColumnIndex: nameIndex + 1 },
            cell: { userEnteredFormat: { horizontalAlignment: 'LEFT' } },
            fields: 'userEnteredFormat.horizontalAlignment'
          }
        });
        if (nameIndex < headers.length - 1) {
          requests.push({
            repeatCell: {
              range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: nameIndex + 1, endColumnIndex: headers.length },
              cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
              fields: 'userEnteredFormat.horizontalAlignment'
            }
          });
        }
      }

      // Add borders: outer bold (SOLID_MEDIUM), inner thin (SOLID)
      const OUTER = hexToColor('#000000');
      const INNER = hexToColor('#e0e0e0');
      requests.push({
        updateBorders: {
          range: {
            sheetId: sheetId,
            startRowIndex: 0,
            endRowIndex: numRows,
            startColumnIndex: 0,
            endColumnIndex: headers.length
          },
          top: { style: 'SOLID_MEDIUM', color: OUTER },
          bottom: { style: 'SOLID_MEDIUM', color: OUTER },
          left: { style: 'SOLID_MEDIUM', color: OUTER },
          right: { style: 'SOLID_MEDIUM', color: OUTER },
          innerHorizontal: { style: 'SOLID', color: INNER },
          innerVertical: { style: 'SOLID', color: INNER }
        }
      });

      // Bold the averages row (last row)
      const avgRowIndex = Math.max(0, numRows - 1);
      requests.push({
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: avgRowIndex,
            endRowIndex: numRows,
            startColumnIndex: 0,
            endColumnIndex: headers.length
          },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold'
        }
      });

      if (requests.length > 0) {
        await sheets.spreadsheets.batchUpdate({ spreadsheetId: sid, requestBody: { requests } });
        console.log('Applied conditional formatting rules and table styling to sheet columns');
      }
      // Replace the original sheet with the new formatted sheet: delete old, rename new
      try {
        const swapReqs = [
          { deleteSheet: { sheetId: originalSheetId } },
          { updateSheetProperties: { properties: { sheetId: sheetId, title: originalTitle }, fields: 'title' } }
        ];
        await sheets.spreadsheets.batchUpdate({ spreadsheetId: sid, requestBody: { requests: swapReqs } });
        console.log('Replaced original sheet with newly formatted sheet');
      } catch (e) {
        console.error('Could not swap sheets (delete old / rename new):', e.message || e);
      }
    } catch (e) {
      console.error('Could not apply table styling/filter/header bold:', e.message || e);
    }
  } catch (e) {
    console.error('Could not apply conditional formatting:', e.message || e);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
